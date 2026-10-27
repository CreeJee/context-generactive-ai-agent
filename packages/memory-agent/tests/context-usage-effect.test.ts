import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { type ChatMetadata, ChatMetadataFailed } from "../src/chat-store/metadata.ts";
import {
  consumeColdObservationEffect,
  ContextUsageFailed,
  ContextUsageReason,
  lastContextUsageEffect,
  pendingColdObservationEffect,
} from "../src/agent/context-usage.ts";

it.effect("keeps context metadata read and write failures typed", () =>
  Effect.gen(function* () {
    const cause = new Error("private metadata failure");
    const metadata: ChatMetadata = {
      get: () => Effect.fail(ChatMetadataFailed.make({ cause })),
      set: () => Effect.fail(ChatMetadataFailed.make({ cause })),
    };
    const read = yield* Effect.flip(lastContextUsageEffect({ metadata, threadId: "thread" }));
    expect(read).toBeInstanceOf(ContextUsageFailed);
    expect(read.operation).toBe("read-usage");
    expect(ContextUsageReason.guards.ReadFailed(read.reason)).toBe(true);
    expect(read.cause).toBe(cause);
    const write = yield* Effect.flip(
      consumeColdObservationEffect({ metadata, threadId: "thread", observationId: "observation" }),
    );
    expect(write.operation).toBe("consume");
    expect(ContextUsageReason.guards.WriteFailed(write.reason)).toBe(true);
    expect(write.cause).toBe(cause);
  }),
);

it.effect("retains cold-observation identity and excludes consumed or legacy reports", () =>
  Effect.gen(function* () {
    let consumed: string | null = null;
    let observationId: string | null = "observation";
    const metadata: ChatMetadata = {
      get: (namespace) =>
        Effect.sync(() =>
          namespace.endsWith("consumed-cold-usage")
            ? consumed
            : { inputTokens: 100, cachedTokens: 0, observationId, compactionStage: null },
        ),
      set: (_namespace, _key, value) =>
        Effect.sync(() => {
          consumed = Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(value));
        }),
    };
    const input = { metadata, threadId: "thread" };
    expect(yield* pendingColdObservationEffect(input)).toBe("observation");
    yield* consumeColdObservationEffect({ ...input, observationId: "observation" });
    expect(yield* pendingColdObservationEffect(input)).toBeNull();
    observationId = null;
    consumed = null;
    expect(yield* pendingColdObservationEffect(input)).toBeNull();
  }),
);
