import { it } from "@effect/vitest";
import { assertExitFailure } from "@effect/vitest/utils";
import type { MetadataStore, ModelMessage } from "@tanstack/ai";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vite-plus/test";
import { compactEffect, compactionStateEffect, lookupSources } from "../src/agent/compaction.ts";

const state = { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] };
const messages: readonly ModelMessage[] = [
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  },
  { role: "tool", toolCallId: "c1", content: "Recorded result" },
  { role: "assistant", content: "Result checked" },
  { role: "user", content: "And then?" },
  { role: "assistant", content: "Done" },
  { role: "user", content: "Continue" },
];

describe("Compaction failure boundaries", () => {
  it.effect("keeps metadata failures in the typed error channel", () =>
    Effect.gen(function* () {
      const cause = new Error("native metadata unavailable");
      const metadata: MetadataStore = {
        get: () => Promise.reject(cause),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      };
      const error = yield* compactionStateEffect({ metadata, threadId: "t1" }).pipe(Effect.flip);
      expect(error._tag).toBe("CompactionFailed");
      expect(error.operation).toBe("read-state");
      expect(error.reason._tag).toBe("MetadataFailed");
      expect(error.cause).toBe(cause);
    }),
  );

  it.effect(
    "preserves business defects instead of treating them as optional retrieval failure",
    () =>
      Effect.gen(function* () {
        const defect = new Error("broken tool-result mapping");
        const exit = yield* compactEffect({
          messages,
          state,
          sources: lookupSources({
            toolResultId: () => {
              throw defect;
            },
            nodeText: () => null,
          }),
          budget: { compactAt: 0, leaveOutAt: 10_000 },
        }).pipe(Effect.exit);
        assertExitFailure(exit, Cause.die(defect));
      }),
  );

  it.effect("interrupts an in-flight native metadata read", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<null>();
      const read = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Deferred.await(finish);
      });
      const metadata: MetadataStore = {
        get: () => Effect.runPromiseWith(context)(read),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      };
      yield* Effect.acquireUseRelease(
        Effect.forkChild(compactionStateEffect({ metadata, threadId: "t1" })),
        (fiber) =>
          Effect.gen(function* () {
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
          }),
        () => Deferred.succeed(finish, null),
      );
    }),
  );
});
