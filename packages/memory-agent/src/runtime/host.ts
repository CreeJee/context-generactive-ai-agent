import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { spawn, type ChildProcess } from "node:child_process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { renameSync, statSync } from "node:fs";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { posix, win32 } from "node:path";
import {
  Array as EffectArray,
  Effect,
  Function as EffectFunction,
  HashSet,
  Option,
  Schedule,
  Schema,
} from "effect";

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
export const findExecutable: {
  (
    env?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
    isFile?: (path: string) => boolean,
  ): (name: string) => ReturnType<typeof findExecutableBody>;
} & typeof findExecutableBody = EffectFunction.dual(
  (args) => Schema.is(Schema.String)(args[0]),
  findExecutableBody,
);
function findExecutableBody(
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

/**
 * The system `tar`. On Windows that is bsdtar in System32 (Windows 10 1803 and later), named by
 * path: a GNU tar earlier on `PATH` (Git for Windows, MSYS) reads `C:\…` as a remote `host:path`.
 */
export const tarExecutable: {
  (platform: NodeJS.Platform): (env: NodeJS.ProcessEnv) => string;
} & typeof tarExecutableBody = EffectFunction.dual(
  (args) => args.length === 0 || !Schema.is(Schema.String)(args[0]),
  tarExecutableBody,
);
function tarExecutableBody(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "win32") return "tar";
  return win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");
}

const ErrorCode = Schema.Struct({ code: Schema.String });
/** What Windows returns while another process (antivirus, search indexer) still holds a file open. */
const busyCodes = HashSet.make("EPERM", "EACCES", "EBUSY");

/**
 * `renameSync`, retried on Windows for up to ~10 s while the moved files are still held open:
 * antivirus may scan freshly written executables or native libraries before releasing their folder.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export class DirectoryRenameFailed extends Schema.TaggedError<DirectoryRenameFailed>()(
  "DirectoryRenameFailed",
  {
    from: Schema.String,
    to: Schema.String,
    reason: Schema.TaggedStruct("RenameFailed", { code: Schema.String }),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `rename_failed (${this.reason.code})`;
  }
}

interface RenameOptions {
  readonly to: string;
  readonly platform?: NodeJS.Platform;
  readonly rename?: (from: string, to: string) => void;
}

export const renameWhenReleased: {
  (options: RenameOptions): (from: string) => Promise<void>;
  (
    from: string,
    to: string,
    platform?: NodeJS.Platform,
    rename?: (from: string, to: string) => void,
  ): Promise<void>;
} = EffectFunction.dual(
  (args) => Schema.is(Schema.String)(args[0]),
  (
    from: string,
    to: string | RenameOptions,
    platform: NodeJS.Platform = process.platform,
    rename: (from: string, to: string) => void = renameSync,
  ) =>
    Effect.runPromise(
      renameWhenReleasedEffect(
        Schema.is(Schema.String)(to) ? { from, to, platform, rename } : { from, ...to },
      ),
    ),
);

export const renameWhenReleasedEffect = Effect.fn("renameWhenReleased")(function* (
  options: RenameOptions & { readonly from: string },
) {
  const { from, to, platform = process.platform, rename = renameSync } = options;
  return yield* Effect.try({
    try: () => rename(from, to),
    catch: (cause) => {
      const decoded = Schema.decodeUnknownOption(ErrorCode)(cause);
      if (Option.isNone(decoded)) throw cause;
      return DirectoryRenameFailed.make({
        from,
        to,
        reason: { _tag: "RenameFailed", code: decoded.value.code },
        cause,
      });
    },
  }).pipe(
    Effect.retry({
      times: 19,
      schedule: Schedule.spaced("500 millis"),
      while: (error) => platform === "win32" && HashSet.has(busyCodes, error.reason.code),
    }),
  );
});

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
 * The environment for a helper program the app runs on its own: only what the system needs to
 * start it and a fixed search path (`searchDirectories`, then the system folders), never
 * the user's other variables (R14). `user` adds the per-user folders on Windows.
 */
export const helperEnvironment: {
  (
    options: { readonly user: boolean },
    env?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ): (searchDirectories: readonly string[]) => ReturnType<typeof helperEnvironmentBody>;
} & typeof helperEnvironmentBody = EffectFunction.dual(
  (args) => EffectArray.isArray(args[0]),
  helperEnvironmentBody,
);
function helperEnvironmentBody(
  searchDirectories: readonly string[],
  options: { readonly user: boolean },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const unique = (directories: readonly string[]) => EffectArray.dedupe(directories);
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

export const shellInvocation: {
  (
    env: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
    exists?: (path: string) => boolean,
  ): (command: string) => ShellInvocation;
} & typeof shellInvocationBody = EffectFunction.dual(
  (args) => Schema.is(Schema.String)(args[0]),
  shellInvocationBody,
);
function shellInvocationBody(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = fileExists,
): ShellInvocation {
  if (platform === "win32") {
    const comSpec = env.ComSpec ?? env.COMSPEC;
    const file =
      isTruthy(comSpec) && win32.isAbsolute(comSpec) && exists(comSpec)
        ? comSpec
        : win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
    // The same form Node uses for `shell: true`: cmd.exe strips the outer quotes and runs the rest.
    return { file, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  const shell = env.SHELL;
  const file = isTruthy(shell) && posix.isAbsolute(shell) && exists(shell) ? shell : "/bin/sh";
  return { file, args: ["-c", command], verbatim: false };
}

/**
 * Ends a child the app started. On Windows a launcher (`npx.cmd` through cmd.exe) would leave the
 * real program running if only the launcher were killed, so the whole tree goes.
 */
export const endChild: {
  (platform?: NodeJS.Platform): (child: ChildProcess) => void;
} & typeof endChildBody = EffectFunction.dual(
  (args) => args.length > 0 && !Schema.is(Schema.UndefinedOr(Schema.String))(args[0]),
  endChildBody,
);
function endChildBody(child: ChildProcess, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32" && child.pid !== undefined) stopProcessTree(child.pid, true, platform);
  else child.kill();
}

/**
 * Stops a process and everything it started. POSIX signals its process group (it must have been
 * spawned `detached`); Windows has no groups or SIGTERM, so `taskkill /T /F` ends the tree at once.
 */
export const stopProcessTree: {
  (force: boolean, platform?: NodeJS.Platform): (pid: number) => void;
} & typeof stopProcessTreeBody = EffectFunction.dual(
  (args) => Schema.is(Schema.Finite)(args[0]),
  stopProcessTreeBody,
);
function stopProcessTreeBody(
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
