import { withTestPlatform } from "./support/platform.ts";
import { expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { DirectoryRenameFailed, renameWhenReleasedEffect } from "../src/runtime/host.ts";

const busy = () => Object.assign(new Error("file held open"), { code: "EPERM" });

it.effect("Windows rename retries stop after twenty attempts", () =>
  Effect.gen(function* () {
    let calls = 0;
    const renamed = yield* Effect.forkChild(
      Effect.flip(
        renameWhenReleasedEffect({
          from: "before",
          to: "after",
          platform: "win32",
          rename: () => {
            calls++;
            throw busy();
          },
        }),
      ),
    );
    yield* TestClock.adjust("10 seconds");
    const failure = yield* Fiber.join(renamed);
    expect(failure).toBeInstanceOf(DirectoryRenameFailed);
    expect(failure.reason.code).toBe("EPERM");
    expect(calls).toBe(20);
  }).pipe(withTestPlatform),
);

it.effect("interruption stops retries and unexpected callback defects remain defects", () =>
  Effect.gen(function* () {
    let calls = 0;
    const renamed = yield* Effect.forkChild(
      renameWhenReleasedEffect({
        from: "before",
        to: "after",
        platform: "win32",
        rename: () => {
          calls++;
          throw busy();
        },
      }),
    );
    yield* TestClock.adjust("500 millis");
    yield* Fiber.interrupt(renamed);
    assertTrue(Exit.hasInterrupts(yield* Fiber.await(renamed)));
    yield* TestClock.adjust("10 seconds");
    expect(calls).toBe(2);
    const defect = new Error("callback bug");
    const exit = yield* Effect.exit(
      renameWhenReleasedEffect({
        from: "before",
        to: "after",
        platform: "win32",
        rename: () => {
          throw defect;
        },
      }),
    );
    assertTrue(Exit.hasDies(exit));
    expect(Cause.squash(exit.cause)).toBe(defect);
  }).pipe(withTestPlatform),
);
