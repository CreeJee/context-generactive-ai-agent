import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, MutableHashMap, Option } from "effect";
import { expect } from "vite-plus/test";
import { agentCommandInvocation } from "./agents.ts";

/** Resolve a Windows launch over a fixture filesystem holding exactly `files`. */
const windowsInvocation = Effect.fnUntraced(function* (
  command: string,
  args: readonly string[],
  files: readonly (readonly [string, string])[],
) {
  const fs = yield* FileSystem.FileSystem;
  const fileInfo = yield* fs.stat(yield* fs.makeTempFileScoped());
  const knownFiles = MutableHashMap.fromIterable(
    files.map(([name, text]) => [name.toLowerCase(), text] as const),
  );
  const missing = FileSystem.makeNoop({});
  const fixtureFs = FileSystem.makeNoop({
    stat: (name) =>
      MutableHashMap.has(knownFiles, name.toLowerCase())
        ? Effect.succeed(fileInfo)
        : missing.stat(name),
    readFileString: (name) =>
      Option.match(MutableHashMap.get(knownFiles, name.toLowerCase()), {
        onNone: () => missing.readFileString(name),
        onSome: Effect.succeed,
      }),
  });
  return yield* agentCommandInvocation({
    command,
    args,
    cwd: "C:\\work",
    env: {
      Path: "C:\\tools;C:\\work\\node_modules\\.bin",
      PATHEXT: ".EXE;.CMD",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    },
    platform: "win32",
  }).pipe(Effect.provideService(FileSystem.FileSystem, fixtureFs));
});

layer(Layer.merge(NodeFileSystem.layer, NodePath.layerWin32))("Windows agent launch", (it) => {
  it.effect("an exe launch preserves literal arguments without a shell", () =>
    Effect.gen(function* () {
      expect(
        yield* windowsInvocation("tool", ["a&b", "%PATH%"], [["C:\\tools\\tool.exe", ""]]),
      ).toEqual({ command: "tool", args: ["a&b", "%PATH%"], shell: undefined });
    }),
  );

  it.effect("an npm command shim escapes metacharacters for both cmd passes", () =>
    Effect.gen(function* () {
      expect(
        yield* windowsInvocation(
          "npx",
          ["a&b", "%PATH%"],
          [["C:\\work\\node_modules\\.bin\\npx.cmd", "@echo off"]],
        ),
      ).toEqual({
        command: 'npx ^^^"a^^^&b^^^" ^^^"^^^%PATH^^^%^^^"',
        args: [],
        shell: "C:\\Windows\\System32\\cmd.exe",
      });
    }),
  );

  it.effect.each([
    "#!/usr/bin/env node --trace-warnings --no-warnings",
    "#!/usr/bin/node --trace-warnings --no-warnings",
  ])("a shebang preserves interpreter flags: %s", (shebang) =>
    Effect.gen(function* () {
      expect(
        yield* windowsInvocation(
          "script",
          ["payload"],
          [
            ["C:\\work\\script", shebang],
            ["C:\\tools\\node.exe", ""],
          ],
        ),
      ).toEqual({
        command: "node",
        args: ["--trace-warnings", "--no-warnings", "C:\\work\\script", "payload"],
        shell: undefined,
      });
    }),
  );
});
