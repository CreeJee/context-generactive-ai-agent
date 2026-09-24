import { Effect } from "effect";
import type { ChatMiddleware, MetadataStore } from "@tanstack/ai";
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
  inputTokens: Schema.Number,
  cachedTokens: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => null)),
  ),
  /** Absent on usage persisted before cache-cold tracking was introduced. */
  observationId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => null)),
  ),
  compactionStage: Schema.NullOr(CompactionStageSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => null)),
  ),
});
const decodeContextUsage = Schema.decodeUnknownOption(ContextUsage);
export type StoredContextUsage = typeof ContextUsage.Type;

export const contextView = (
  usedTokens: number | null,
  windowTokens: number,
  cachedTokens: number | null = null,
  compactionStage: CompactionStage | null = null,
): ContextView => ({
  usedTokens,
  cachedTokens,
  cacheRatio:
    usedTokens === null || usedTokens <= 0 || cachedTokens === null
      ? null
      : cachedTokens / usedTokens,
  compactionStage,
  windowTokens,
  compactAtTokens: budgetFor(windowTokens).compactAt,
});

/** The latest provider-reported prompt/cache usage in a session, if it has made a request. */
export const lastContextUsage = async (
  metadata: MetadataStore,
  threadId: string,
): Promise<StoredContextUsage | null> =>
  Option.getOrNull(decodeContextUsage(await metadata.get(contextUsageNamespace, threadId)));

/** A provider-reported zero is distinct from no report; each observation may trigger only once. */
export const coldObservationId = (
  usage: StoredContextUsage | null,
  consumedId: string | null,
): string | null =>
  usage?.cachedTokens === 0 && usage.observationId && usage.observationId !== consumedId
    ? usage.observationId
    : null;

/** Read the pending observation without treating legacy/unknown usage as a cache miss. */
export async function pendingColdObservation(
  metadata: MetadataStore,
  threadId: string,
): Promise<string | null> {
  const [usage, consumed] = await Promise.all([
    lastContextUsage(metadata, threadId),
    metadata.get(consumedColdUsageNamespace, threadId),
  ]);
  const consumedId = Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(consumed));
  return coldObservationId(usage, consumedId);
}

/** Consume an observation when the request has attempted its early compact. */
export const consumeColdObservation = (
  metadata: MetadataStore,
  threadId: string,
  observationId: string,
): Promise<void> => metadata.set(consumedColdUsageNamespace, threadId, observationId);

/** The tokens the model read in its latest request in a session, if it has made one. */
export const lastInputTokens = async (metadata: MetadataStore, threadId: string) =>
  (await lastContextUsage(metadata, threadId))?.inputTokens ?? null;

/**
 * Keeps how much each model request of a run read, and tells the page as it happens.
 * `windowTokens` is asked each time, since the window is learned from the model's reports.
 */
export function recordContextUsage(
  metadata: MetadataStore,
  windowTokens: () => number,
  compactionStage: () => CompactionStage = () => "none",
): ChatMiddleware {
  return {
    name: "memory-agent/context-usage",
    async onUsage(ctx, usage) {
      const cachedTokens = usage.promptTokensDetails?.cachedTokens ?? null;
      const stored: StoredContextUsage = {
        inputTokens: usage.promptTokens,
        cachedTokens,
        observationId: randomUUID(),
        compactionStage: compactionStage(),
      };
      await metadata.set(contextUsageNamespace, ctx.threadId, stored);
      ctx.emitCustomEvent(
        contextUsageEvent,
        contextView(usage.promptTokens, windowTokens(), cachedTokens, stored.compactionStage),
      );
    },
  };
}
