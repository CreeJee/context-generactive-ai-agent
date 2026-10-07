import { it } from "@effect/vitest";
import type { MetadataStore } from "@tanstack/ai";
import { Effect, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  consumeColdObservationEffect,
  lastContextUsageEffect,
  pendingColdObservationEffect,
} from "../src/agent/context-usage.ts";

it.effect("keeps context metadata read and write failures typed", () =>
  Effect.gen(function* () {
    const cause = new Error("private metadata failure");
    const metadata: MetadataStore = {
      get: () => Promise.reject(cause),
      set: () => Promise.reject(cause),
      delete: () => Promise.resolve(),
    };
    const read = yield* Effect.flip(lastContextUsageEffect({ metadata, threadId: "thread" }));
    expect(read._tag).toBe("ContextUsageFailed");
    expect(read.operation).toBe("read-usage");
    expect(read.reason._tag).toBe("ReadFailed");
    expect(read.cause).toBe(cause);
    const write = yield* Effect.flip(
      consumeColdObservationEffect({ metadata, threadId: "thread", observationId: "observation" }),
    );
    expect(write.operation).toBe("consume");
    expect(write.reason._tag).toBe("WriteFailed");
    expect(write.cause).toBe(cause);
  }),
);

it.effect("retains cold-observation identity and excludes consumed or legacy reports", () =>
  Effect.gen(function* () {
    let consumed: string | null = null;
    let observationId: string | null = "observation";
    const metadata: MetadataStore = {
      get: (namespace) =>
        Promise.resolve(
          namespace.endsWith("consumed-cold-usage")
            ? consumed
            : { inputTokens: 100, cachedTokens: 0, observationId, compactionStage: null },
        ),
      set: (_namespace, _key, value) => {
        consumed = Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(value));
        return Promise.resolve();
      },
      delete: () => Promise.resolve(),
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
