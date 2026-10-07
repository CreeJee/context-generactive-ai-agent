import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Effect } from "effect";
import type { ChatMiddleware, MetadataStore } from "@tanstack/ai";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
import { Option, Schema } from "effect";
import { budgetFor } from "./compaction.ts";
import { contextUsageEvent, type CompactionStage, type ContextView } from "./run-state.ts";

/** Where a session's latest model request size is kept. */
export const contextUsageNamespace = "memory-agent/context-usage";
/** Last provider observation for which a cache-cold compact was attempted. */
export const consumedColdUsageNamespace = "memory-agent/consumed-cold-usage";

const CompactionStageSchema = Schema.Literals(["none", "clear-answered", "summarize", "leave-out"]);
const ContextUsage = Schema.Struct({
  inputTokens: Schema.Finite,
  cachedTokens: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  /** Absent on usage persisted before cache-cold tracking was introduced. */
  observationId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  compactionStage: Schema.NullOr(CompactionStageSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
});
const decodeContextUsage = Schema.decodeUnknownOption(ContextUsage);
export type StoredContextUsage = typeof ContextUsage.Type;

export const contextView = ({
  usedTokens,
  windowTokens,
  cachedTokens = null,
  compactionStage = null,
  windowKnown = false,
}: {
  readonly usedTokens: number | null;
  readonly windowTokens: number;
  readonly cachedTokens?: number | null;
  readonly compactionStage?: CompactionStage | null;
  readonly windowKnown?: boolean;
}): ContextView => ({
  usedTokens,
  cachedTokens,
  cacheRatio:
    usedTokens === null || usedTokens <= 0 || cachedTokens === null
      ? null
      : cachedTokens / usedTokens,
  compactionStage,
  windowTokens,
  windowKnown,
  compactAtTokens: budgetFor(windowTokens).compactAt,
});

export class ContextUsageFailed extends Schema.TaggedError<ContextUsageFailed>()(
  "ContextUsageFailed",
  {
    operation: Schema.Literals(["read-usage", "read-consumed", "write-usage", "consume"]),
    reason: Schema.Union([
      Schema.TaggedStruct("ReadFailed", {}),
      Schema.TaggedStruct("WriteFailed", {}),
    ]),
    cause: Schema.Defect(),
  },
) {}

const metadataOperation = <A>(
  operation: ContextUsageFailed["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, ContextUsageFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      ContextUsageFailed.make({
        operation,
        reason: {
          _tag:
            operation === "read-usage" || operation === "read-consumed"
              ? "ReadFailed"
              : "WriteFailed",
        },
        cause,
      }),
  });

export const lastContextUsageEffect = (input: {
  readonly metadata: MetadataStore;
  readonly threadId: string;
}) =>
  metadataOperation("read-usage", () =>
    input.metadata.get(contextUsageNamespace, input.threadId),
  ).pipe(Effect.map((stored) => Option.getOrNull(decodeContextUsage(stored))));

/** The latest provider-reported prompt/cache usage in a session, if it has made a request. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const lastContextUsageBody = (metadata: MetadataStore, threadId: string) =>
  Effect.runPromise(lastContextUsageEffect({ metadata, threadId }));
export const lastContextUsage: {
  (threadId: string): (metadata: MetadataStore) => ReturnType<typeof lastContextUsageBody>;
} & typeof lastContextUsageBody = EffectFunction.dual(2, lastContextUsageBody);

/** A provider-reported zero is distinct from no report; each observation may trigger only once. */
const coldObservationIdBody = (
  usage: StoredContextUsage | null,
  consumedId: string | null,
): string | null =>
  usage?.cachedTokens === 0 && isTruthy(usage.observationId) && usage.observationId !== consumedId
    ? usage.observationId
    : null;
export const coldObservationId: {
  (
    consumedId: string | null,
  ): (usage: StoredContextUsage | null) => ReturnType<typeof coldObservationIdBody>;
} & typeof coldObservationIdBody = EffectFunction.dual(2, coldObservationIdBody);

/** Read the pending observation without treating legacy/unknown usage as a cache miss. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const pendingColdObservation: {
  (threadId: string): (metadata: MetadataStore) => ReturnType<typeof pendingColdObservationBody>;
} & typeof pendingColdObservationBody = EffectFunction.dual(2, pendingColdObservationBody);
export const pendingColdObservationEffect = (input: {
  readonly metadata: MetadataStore;
  readonly threadId: string;
}) =>
  Effect.gen(function* () {
    const [usage, consumed] = yield* Effect.all(
      [
        lastContextUsageEffect(input),
        metadataOperation("read-consumed", () =>
          input.metadata.get(consumedColdUsageNamespace, input.threadId),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const consumedId = Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(consumed));
    return coldObservationId(usage, consumedId);
  });
function pendingColdObservationBody(
  metadata: MetadataStore,
  threadId: string,
): Promise<string | null> {
  return Effect.runPromise(pendingColdObservationEffect({ metadata, threadId }));
}

/** Consume an observation when the request has attempted its early compact. */
const consumeColdObservationBody = (
  metadata: MetadataStore,
  threadId: string,
  observationId: string,
): Promise<void> =>
  Effect.runPromise(consumeColdObservationEffect({ metadata, threadId, observationId }));
export const consumeColdObservationEffect = (input: {
  readonly metadata: MetadataStore;
  readonly threadId: string;
  readonly observationId: string;
}) =>
  metadataOperation("consume", () =>
    input.metadata.set(consumedColdUsageNamespace, input.threadId, input.observationId),
  );
export const consumeColdObservation: {
  (
    threadId: string,
    observationId: string,
  ): (metadata: MetadataStore) => ReturnType<typeof consumeColdObservationBody>;
} & typeof consumeColdObservationBody = EffectFunction.dual(3, consumeColdObservationBody);

/** The tokens the model read in its latest request in a session, if it has made one. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const lastInputTokensBody = (metadata: MetadataStore, threadId: string) =>
  Effect.runPromise(
    lastContextUsageEffect({ metadata, threadId }).pipe(
      Effect.map((usage) => usage?.inputTokens ?? null),
    ),
  );
export const lastInputTokens: {
  (threadId: string): (metadata: MetadataStore) => ReturnType<typeof lastInputTokensBody>;
} & typeof lastInputTokensBody = EffectFunction.dual(2, lastInputTokensBody);

/**
 * Keeps how much each model request of a run read, and tells the page as it happens.
 * The window and its provenance are read on each request from the current model catalog.
 */
export function recordContextUsage({
  metadata,
  windowTokens,
  compactionStage = () => "none",
  windowKnown = () => false,
}: {
  readonly metadata: MetadataStore;
  readonly windowTokens: () => number;
  readonly compactionStage?: () => CompactionStage;
  readonly windowKnown?: () => boolean;
}): ChatMiddleware {
  return {
    name: "memory-agent/context-usage",
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onUsage: (ctx, usage) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const cachedTokens = usage.promptTokensDetails?.cachedTokens ?? null;
          const stored: StoredContextUsage = {
            inputTokens: usage.promptTokens,
            cachedTokens,
            observationId: randomUUID(),
            compactionStage: compactionStage(),
          };
          yield* metadataOperation("write-usage", () =>
            metadata.set(contextUsageNamespace, ctx.threadId, stored),
          );
          ctx.emitCustomEvent(
            contextUsageEvent,
            contextView({
              usedTokens: usage.promptTokens,
              windowTokens: windowTokens(),
              cachedTokens,
              compactionStage: stored.compactionStage,
              windowKnown: windowKnown(),
            }),
          );
        }),
      ),
  };
}
