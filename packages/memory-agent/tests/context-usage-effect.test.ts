import { it } from "@effect/vitest";
import { Effect, MutableRef, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { ChatMetadata } from "../src/chat-store/metadata.ts";
import {
  consumeColdObservationEffect,
  pendingColdObservationEffect,
} from "../src/agent/context-usage.ts";

it.effect("retains cold-observation identity and excludes consumed or legacy reports", () =>
  Effect.gen(function* () {
    const consumed = MutableRef.make<string | null>(null);
    const observationId = MutableRef.make<string | null>("observation");
    const metadata: ChatMetadata = {
      get: (namespace) =>
        Effect.sync(() =>
          namespace.endsWith("consumed-cold-usage")
            ? MutableRef.get(consumed)
            : {
                inputTokens: 100,
                cachedTokens: 0,
                observationId: MutableRef.get(observationId),
                compactionStage: null,
              },
        ),
      set: (_namespace, _key, value) =>
        Effect.sync(() => {
          MutableRef.set(
            consumed,
            Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(value)),
          );
        }),
      summaries: () => Effect.succeed([]),
      replaceSummaries: () => Effect.void,
    };
    const input = { metadata, threadId: "thread" };
    expect(yield* pendingColdObservationEffect(input)).toBe("observation");
    yield* consumeColdObservationEffect({ ...input, observationId: "observation" });
    expect(yield* pendingColdObservationEffect(input)).toBeNull();
    MutableRef.set(observationId, null);
    MutableRef.set(consumed, null);
    expect(yield* pendingColdObservationEffect(input)).toBeNull();
  }),
);
