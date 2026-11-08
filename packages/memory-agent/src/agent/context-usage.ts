import { Effect } from "effect";
import type { ChatMetadata, ChatMetadataFailed } from "../chat-store/metadata.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { RunStore } from "../loop/store.ts";
import { Option, Schema } from "effect";
import { budgetFor } from "./compaction.ts";
import { contextUsageEvent, type CompactionStage, type ContextView } from "./run-state.ts";

/** Where a session's latest model request size is kept. */
export const contextUsageNamespace = "memory-agent/context-usage";

const CompactionStageSchema = Schema.Literals(["none", "clear-answered", "summarize", "leave-out"]);
const ContextUsage = Schema.Struct({
  inputTokens: Schema.Finite,
  cachedTokens: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  compactionStage: Schema.NullOr(CompactionStageSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
  /** Our estimate of the messages the request sent, which `inputTokens` counts with the rest. */
  estimatedTokens: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
  ),
});
const decodeContextUsage = Schema.decodeUnknownOption(ContextUsage);
export type StoredContextUsage = typeof ContextUsage.Type;

/**
 * What the provider counted of a session's latest request beyond our estimate of its messages, if
 * both were kept: the system prompt, tool definitions and its own tokenizer.
 */
export const measuredOverhead = (usage: StoredContextUsage | null) =>
  Option.flatMap(Option.fromNullishOr(usage), ({ inputTokens, estimatedTokens }) =>
    Option.map(Option.fromNullishOr(estimatedTokens), (estimate) => inputTokens - estimate),
  );

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
  operation: Schema.Literals(["read-usage", "write-usage"]),
  reason: ContextUsageReason,
  cause: Schema.Defect(),
}) {}

const metadataFailed =
  (operation: ContextUsageFailed["operation"]) =>
  ({ cause }: ChatMetadataFailed) =>
    ContextUsageFailed.make({
      operation,
      reason:
        operation === "read-usage"
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

/**
 * Keeps how much each model request of a run read, in the run store's chat metadata, and tells the
 * page as it happens. The window and its provenance are read on each request from the current
 * model catalog.
 */
export const contextUsageHook = (options: {
  readonly windowTokens: Effect.Effect<number>;
  readonly compactionStage: Effect.Effect<CompactionStage>;
  /** Our estimate of the messages the latest request sent, once one was sent. */
  readonly estimatedTokens: Effect.Effect<Option.Option<number>>;
  readonly windowKnown: Effect.Effect<boolean>;
}): RunHook<RunStore> => ({
  usage: ({ threadId, emit }, { inputTokens }) =>
    Effect.transposeOption(
      Option.map(Option.fromNullishOr(inputTokens.total), (usedTokens) =>
        Effect.gen(function* () {
          const store = yield* RunStore;
          const stored: StoredContextUsage = {
            inputTokens: usedTokens,
            cachedTokens: inputTokens.cacheRead ?? null,
            compactionStage: yield* options.compactionStage,
            estimatedTokens: Option.getOrNull(yield* options.estimatedTokens),
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
