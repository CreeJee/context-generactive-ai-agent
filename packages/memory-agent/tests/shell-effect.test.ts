import { withTestPlatform } from "./support/platform.ts";
import { it, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Fiber, FileSystem, Path, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";
import { runCommandEffect } from "../src/shell/run.ts";

const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" };

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("interrupting a command drains its process group before returning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const running = yield* runCommandEffect({
        command: "echo $$ > child.pid; sleep 30",
        cwd,
        timeoutSeconds: 60,
        signal: undefined,
        env,
      }).pipe(Effect.forkChild);
      const recorded = yield* fs
        .readFileString(path.join(cwd, "child.pid"))
        .pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }));
      const pid = yield* Schema.decodeEffect(
        Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
      )(recorded.trim());
      yield* Fiber.interrupt(running);
      expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  );
});

it.live("native process startup failures use the typed error channel", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      runCommandEffect({
        command: "true",
        cwd: "/missing-context-agent-command-directory",
        timeoutSeconds: 10,
        signal: undefined,
        env,
      }),
    );
    expect(failure._tag).toBe("CommandStartFailed");
    expect(failure.reason._tag).toBe("SpawnFailed");
  }).pipe(withTestPlatform),
);

it.effect("defects in command preparation stay defects", () =>
  Effect.gen(function* () {
    const defect = new Error("invalid command environment implementation");
    const broken = Object.defineProperty({}, "SHELL", {
      get: () => {
        throw defect;
      },
    });
    const exit = yield* Effect.exit(
      runCommandEffect({
        command: "true",
        cwd: "/tmp",
        timeoutSeconds: 10,
        signal: undefined,
        env: broken,
      }),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  }).pipe(withTestPlatform),
);
