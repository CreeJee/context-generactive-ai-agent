import type { ChatMiddleware, MetadataStore } from "@tanstack/ai";
import { Option, Schema } from "effect";
import { budgetFor } from "./compaction.ts";
import { contextUsageEvent, type CompactionStage, type ContextView } from "./run-state.ts";

/** Where a session's latest model request size is kept. */
export const contextUsageNamespace = "memory-agent/context-usage";

const CompactionStageSchema = Schema.Literal("none", "clear-answered", "summarize", "leave-out");
const ContextUsage = Schema.Struct({
  inputTokens: Schema.Number,
  cachedTokens: Schema.optionalWith(Schema.NullOr(Schema.Number), { default: () => null }),
  compactionStage: Schema.optionalWith(Schema.NullOr(CompactionStageSchema), {
    default: () => null,
  }),
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
