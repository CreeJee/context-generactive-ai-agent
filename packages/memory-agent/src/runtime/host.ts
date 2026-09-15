import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Host differences between POSIX systems and Windows, in one place. Every function takes the
 * platform and environment so both branches can be tested on either system.
 */

const pathModule = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** `PATH` as the platform spells it (`Path` is common on Windows). */
const searchPath = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  (platform === "win32" ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? "";

/**
 * An executable found on the absolute entries of `PATH` only, so a relative entry (a project
 * folder) can never shadow it. On Windows the `PATHEXT` extensions (`.exe`, `.cmd`, …) are tried.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = fileExists,
): string | null {
  const path = pathModule(platform);
  const extensions =
    platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const directory of searchPath(env, platform).split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension.toLowerCase()}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function fileExists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What Windows programs need to start at all, whatever else they are given. */
const windowsSystemVariables = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "PROCESSOR_ARCHITECTURE",
];

/** Per-user folders on Windows: the credential store and app data resolve through these. */
const windowsUserVariables = [
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramFiles",
  "ProgramData",
];

const pick = (env: NodeJS.ProcessEnv, names: readonly string[]) =>
  Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));

/**
 * The environment for a helper program the app runs on its own (codex, git): only what the system
 * needs to start it and a fixed search path (`searchDirectories`, then the system folders), never
 * the user's other variables (R14). `user` adds the per-user folders on Windows.
 */
export function helperEnvironment(
  searchDirectories: readonly string[],
  options: { readonly user: boolean },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const unique = (directories: readonly string[]) => [...new Set(directories)];
  if (platform !== "win32")
    return { PATH: unique([...searchDirectories, "/usr/bin", "/bin"]).join(posix.delimiter) };
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return {
    ...pick(
      env,
      options.user ? [...windowsSystemVariables, ...windowsUserVariables] : windowsSystemVariables,
    ),
    SystemRoot: systemRoot,
    Path: unique([...searchDirectories, win32.join(systemRoot, "System32"), systemRoot]).join(
      win32.delimiter,
    ),
  };
}

/** How the user's shell runs one command line: `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. */
export interface ShellInvocation {
  readonly file: string;
  readonly args: readonly string[];
  /** Windows only: pass the quoted command line to cmd.exe exactly as written. */
  readonly verbatim: boolean;
}

export function shellInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = fileExists,
): ShellInvocation {
  if (platform === "win32") {
    const comSpec = env.ComSpec ?? env.COMSPEC;
    const file =
      comSpec && win32.isAbsolute(comSpec) && exists(comSpec)
        ? comSpec
        : win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
    // The same form Node uses for `shell: true`: cmd.exe strips the outer quotes and runs the rest.
    return { file, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  const shell = env.SHELL;
  const file = shell && posix.isAbsolute(shell) && exists(shell) ? shell : "/bin/sh";
  return { file, args: ["-c", command], verbatim: false };
}

/**
 * Ends a child the app started. On Windows a launcher (`npx.cmd` through cmd.exe) would leave the
 * real program running if only the launcher were killed, so the whole tree goes.
 */
export function endChild(child: ChildProcess, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32" && child.pid !== undefined) stopProcessTree(child.pid, true, platform);
  else child.kill();
}

/**
 * Stops a process and everything it started. POSIX signals its process group (it must have been
 * spawned `detached`); Windows has no groups or SIGTERM, so `taskkill /T /F` ends the tree at once.
 */
export function stopProcessTree(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => undefined,
    );
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The group already exited.
  }
}
