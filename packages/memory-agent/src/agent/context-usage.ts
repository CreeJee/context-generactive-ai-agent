import { Crypto, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { Effect } from "effect";
import type { ChatMetadata, ChatMetadataFailed } from "../chat-store/metadata.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { RunStore } from "../loop/store.ts";
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

export const ContextUsageReason = Schema.TaggedUnion({ ReadFailed: {}, WriteFailed: {} });

export class ContextUsageFailed extends Schema.TaggedError<
  ContextUsageFailed,
  { readonly brand: unique symbol }
>()("ContextUsageFailed", {
  operation: Schema.Literals(["read-usage", "read-consumed", "write-usage", "consume"]),
  reason: ContextUsageReason,
  cause: Schema.Defect(),
}) {}

const metadataFailed =
  (operation: ContextUsageFailed["operation"]) =>
  ({ cause }: ChatMetadataFailed) =>
    ContextUsageFailed.make({
      operation,
      reason:
        operation === "read-usage" || operation === "read-consumed"
          ? ContextUsageReason.cases.ReadFailed.make({})
          : ContextUsageReason.cases.WriteFailed.make({}),
      cause,
    });

/** The latest provider-reported prompt/cache usage in a session, if it has made a request. */
export const lastContextUsageEffect = (input: {
  readonly metadata: ChatMetadata;
  readonly threadId: string;
}) =>
  input.metadata.get(contextUsageNamespace, input.threadId).pipe(
    Effect.mapError(metadataFailed("read-usage")),
    Effect.map((stored) => Option.getOrNull(decodeContextUsage(stored))),
  );

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
export const pendingColdObservationEffect = (input: {
  readonly metadata: ChatMetadata;
  readonly threadId: string;
}) =>
  Effect.gen(function* () {
    const [usage, consumed] = yield* Effect.all(
      [
        lastContextUsageEffect(input),
        input.metadata
          .get(consumedColdUsageNamespace, input.threadId)
          .pipe(Effect.mapError(metadataFailed("read-consumed"))),
      ],
      { concurrency: "unbounded" },
    );
    const consumedId = Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(consumed));
    return coldObservationId(usage, consumedId);
  });
/** Consume an observation when the request has attempted its early compact. */
export const consumeColdObservationEffect = (input: {
  readonly metadata: ChatMetadata;
  readonly threadId: string;
  readonly observationId: string;
}) =>
  input.metadata
    .set(consumedColdUsageNamespace, input.threadId, input.observationId)
    .pipe(Effect.mapError(metadataFailed("consume")));
/**
 * Keeps how much each model request of a run read, in the run store's chat metadata, and tells the
 * page as it happens. The window and its provenance are read on each request from the current
 * model catalog.
 */
export const contextUsageHook = (options: {
  readonly windowTokens: Effect.Effect<number>;
  readonly compactionStage: Effect.Effect<CompactionStage>;
  readonly windowKnown: Effect.Effect<boolean>;
}): RunHook<RunStore | Crypto.Crypto> => ({
  usage: ({ threadId, emit }, { inputTokens }) =>
    Effect.transposeOption(
      Option.map(Option.fromNullishOr(inputTokens.total), (usedTokens) =>
        Effect.gen(function* () {
          const store = yield* RunStore;
          const crypto = yield* Crypto.Crypto;
          const stored: StoredContextUsage = {
            inputTokens: usedTokens,
            cachedTokens: inputTokens.cacheRead ?? null,
            observationId: yield* crypto.randomUUIDv4(),
            compactionStage: yield* options.compactionStage,
          };
          yield* store.metadata.set(contextUsageNamespace, threadId, stored);
          yield* emit({
            type: "CUSTOM",
            name: contextUsageEvent,
            value: contextView({
              usedTokens,
              windowTokens: yield* options.windowTokens,
              cachedTokens: stored.cachedTokens,
              compactionStage: stored.compactionStage,
              windowKnown: yield* options.windowKnown,
            }),
          });
        }),
      ),
    ).pipe(Effect.asVoid, Effect.mapError(asRunFailed)),
});
