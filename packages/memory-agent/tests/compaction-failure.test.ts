import { it } from "@effect/vitest";
import { assertExitFailure } from "@effect/vitest/utils";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  CompactionFailed,
  CompactionReason,
  compactEffect,
  compactionStateEffect,
  lookupSources,
} from "../src/agent/compaction.ts";
import { type ChatMetadata, ChatMetadataFailed } from "../src/chat-store/metadata.ts";
import type { StoredMessage } from "../src/chat-store/schema.ts";

const state = { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] };
const messages: ReadonlyArray<StoredMessage> = [
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
      const metadata: ChatMetadata = {
        get: () => Effect.fail(ChatMetadataFailed.make({ cause })),
        set: () => Effect.void,
      };
      const error = yield* compactionStateEffect({ metadata, threadId: "t1" }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CompactionFailed);
      expect(error.operation).toBe("read-state");
      expect(CompactionReason.guards.MetadataFailed(error.reason)).toBe(true);
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

  it.effect("interrupts an in-flight metadata read", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<null>();
      const metadata: ChatMetadata = {
        get: () => Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(finish)),
        set: () => Effect.void,
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
