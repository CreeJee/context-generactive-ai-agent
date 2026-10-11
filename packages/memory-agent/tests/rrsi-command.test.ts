import { expect, it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { Effect, FileSystem, Path } from "effect";
import { runProcess } from "../src/rrsi/command.ts";

it.live(
  "collects command streams and rejects nonzero exit, overflow, timeout and cancellation",
  () => {
    // The SDK caller explicitly cancels its Promise through its native AbortSignal contract.
    const controller = new AbortController();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rrsi-command-" });
      const fixture = path.join(directory, "command.ts");
      yield* fs.writeFileString(
        fixture,
        `
        switch (process.argv[2]) {
          case "success": process.stdout.write("한글😀"); process.stderr.write("stderr"); break;
          case "failure": process.exitCode = 7; break;
          case "overflow": process.stdout.write("x".repeat(128)); break;
          case "wait": setInterval(() => {}, 1000); break;
        }
      `,
      );
      const execute = (
        mode: string,
        options: { maxBuffer?: number; timeout?: number; signal?: AbortSignal } = {},
      ) =>
        Effect.tryPromise(() =>
          runProcess({
            command: process.execPath,
            args: [fixture, mode],
            cwd: directory,
            ...options,
          }),
        );
      expect(yield* execute("success")).toEqual({ stdout: "한글😀", stderr: "stderr" });
      expect(String((yield* Effect.flip(execute("failure"))).cause)).toContain("exit 7");
      expect(String((yield* Effect.flip(execute("overflow", { maxBuffer: 32 }))).cause)).toContain(
        "command_output_limit",
      );
      yield* Effect.flip(execute("wait", { timeout: 100 }));
      yield* Effect.forkChild(
        Effect.sleep("100 millis").pipe(Effect.andThen(Effect.sync(() => controller.abort()))),
      );
      yield* Effect.flip(execute("wait", { signal: controller.signal })).pipe(
        Effect.timeout("2 seconds"),
      );
    }).pipe(withTestPlatform);
  },
);
