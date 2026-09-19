import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { toolLocations } from "../src/acp/tool-view.ts";
import {
  findExecutable,
  helperEnvironment,
  renameWhenReleased,
  shellInvocation,
  tarExecutable,
} from "../src/runtime/host.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const windowsEnv = {
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  USERPROFILE: "C:\\Users\\me",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  Path: "C:\\Program Files\\Git\\cmd;.\\node_modules\\.bin;C:\\Users\\me\\AppData\\Roaming\\npm",
  GITHUB_TOKEN: "secret",
};

describe("host differences", () => {
  test("finds executables on absolute PATH entries only, with PATHEXT on Windows", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-host-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, "bin"));
    writeFileSync(join(base, "bin", "git"), "");
    expect(findExecutable("git", { PATH: `relative:${join(base, "bin")}` }, "linux")).toBe(
      join(base, "bin", "git"),
    );
    expect(findExecutable("git", { PATH: "relative" }, "linux")).toBeNull();

    const existing = new Set([
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd",
    ]);
    const onWindows = (name: string) =>
      findExecutable(name, windowsEnv, "win32", (path) => existing.has(path));
    expect(onWindows("git")).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    expect(onWindows("npx")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd");
  });

  test("helper programs get the system folders and what Windows needs, never the user's secrets", () => {
    expect(
      helperEnvironment(["/opt/homebrew/bin"], { user: false }, { HOME: "/Users/me" }, "darwin"),
    ).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    });
    const windows = helperEnvironment(
      ["C:\\Program Files\\Git\\cmd"],
      { user: false },
      windowsEnv,
      "win32",
    );
    expect(windows).toMatchObject({
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows",
    });
    expect(windows).not.toHaveProperty("USERPROFILE");
    expect(windows).not.toHaveProperty("GITHUB_TOKEN");
    expect(helperEnvironment([], { user: true }, windowsEnv, "win32")).toHaveProperty(
      "APPDATA",
      "C:\\Users\\me\\AppData\\Roaming",
    );
  });

  test("commands run through sh -c, or cmd.exe /d /s /c on Windows", () => {
    expect(shellInvocation("ls", { SHELL: "/bin/zsh" }, "darwin", () => true)).toEqual({
      file: "/bin/zsh",
      args: ["-c", "ls"],
      verbatim: false,
    });
    expect(shellInvocation("ls", { SHELL: "zsh" }, "linux", () => true).file).toBe("/bin/sh");
    expect(shellInvocation("dir /b", windowsEnv, "win32", () => true)).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"dir /b"'],
      verbatim: true,
    });
    expect(shellInvocation("dir", { SystemRoot: "D:\\Win" }, "win32", () => false).file).toBe(
      "D:\\Win\\System32\\cmd.exe",
    );
  });

  test("archives extract with System32 tar on Windows, whatever tar comes first on PATH", () => {
    expect(tarExecutable({ PATH: "/usr/bin" }, "darwin")).toBe("tar");
    expect(tarExecutable(windowsEnv, "win32")).toBe("C:\\Windows\\System32\\tar.exe");
  });

  test("a folder still held open by antivirus is renamed once released, on Windows only", async () => {
    const busy = () => Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const renameAfter = (failures: number) => {
      let calls = 0;
      return {
        rename: () => {
          calls++;
          if (calls <= failures) throw busy();
        },
        calls: () => calls,
      };
    };
    const windows = renameAfter(2);
    await renameWhenReleased("a", "b", "win32", windows.rename);
    expect(windows.calls()).toBe(3);

    const posix = renameAfter(1);
    await expect(renameWhenReleased("a", "b", "linux", posix.rename)).rejects.toThrow(
      "not permitted",
    );
    expect(posix.calls()).toBe(1);
  });

  test("ACP tool locations resolve project-relative paths and normalize them", () => {
    const args = (path: string) => JSON.stringify({ path });
    expect(toolLocations(args("src/../README.md"), "/work/app")).toEqual([
      { path: "/work/app/README.md" },
    ]);
    expect(toolLocations(args("/etc/hosts"), "/work/app")).toEqual([{ path: "/etc/hosts" }]);
    expect(toolLocations(JSON.stringify({ command: "ls" }), "/work/app")).toEqual([]);
  });
});
