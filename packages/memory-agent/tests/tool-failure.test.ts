import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { guardedEffect, ToolFailed } from "../src/tools/failure.ts";

it.effect("a ToolFailed keeps its code through guardedEffect", () =>
  Effect.gen(function* () {
    const failed = ToolFailed.make({
      code: "sandbox_failed",
      tag: "CodeSandboxFailed",
      detail: "x",
    });
    const rejected = yield* Effect.flip(guardedEffect("run_skill", Effect.fail(failed)));
    expect(rejected.cause).toBe(failed);
  }),
);
