import { HashSet } from "effect";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { toolLocations } from "../src/acp/tool-view.ts";
import {
  findExecutable,
  helperEnvironment,
  shellInvocation,
  tarExecutable,
} from "../src/runtime/host.ts";
import { withTestPlatform } from "./support/platform.ts";

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
  it.live("finds executables on absolute PATH entries only, with PATHEXT on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-host-" });
      const base = yield* fs.realPath(directory);
      yield* fs.makeDirectory(path.join(base, "bin"));
      yield* fs.writeFileString(path.join(base, "bin", "git"), "");
      expect(
        yield* findExecutable("git", { PATH: `relative:${path.join(base, "bin")}` }, "linux"),
      ).toBe(path.join(base, "bin", "git"));
      expect(yield* findExecutable("git", { PATH: "relative" }, "linux")).toBeNull();

      const existing = HashSet.fromIterable([
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd",
      ]);
      const onWindows = (name: string) =>
        findExecutable(name, windowsEnv, "win32", (path) => HashSet.has(existing, path));
      expect(yield* onWindows("git")).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
      expect(yield* onWindows("npx")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd");
    }).pipe(withTestPlatform),
  );

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

  it.effect("commands run through sh -c, or cmd.exe /d /s /c on Windows", () =>
    Effect.gen(function* () {
      expect(yield* shellInvocation("ls", { SHELL: "/bin/zsh" }, "darwin", () => true)).toEqual({
        file: "/bin/zsh",
        args: ["-c", "ls"],
        verbatim: false,
      });
      expect((yield* shellInvocation("ls", { SHELL: "zsh" }, "linux", () => true)).file).toBe(
        "/bin/sh",
      );
      expect(yield* shellInvocation("dir /b", windowsEnv, "win32", () => true)).toEqual({
        file: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '"dir /b"'],
        verbatim: true,
      });
      expect(
        (yield* shellInvocation("dir", { SystemRoot: "D:\\Win" }, "win32", () => false)).file,
      ).toBe("D:\\Win\\System32\\cmd.exe");
    }).pipe(withTestPlatform),
  );

  test("archives extract with System32 tar on Windows, whatever tar comes first on PATH", () => {
    expect(tarExecutable({ PATH: "/usr/bin" }, "darwin")).toBe("tar");
    expect(tarExecutable(windowsEnv, "win32")).toBe("C:\\Windows\\System32\\tar.exe");
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
