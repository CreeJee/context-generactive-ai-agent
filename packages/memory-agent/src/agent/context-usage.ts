import type { ChatMiddleware, MetadataStore } from "@tanstack/ai";
import { Option, Schema } from "effect";
import { budgetFor } from "./compaction.ts";
import { contextUsageEvent, type ContextView } from "./run-state.ts";

/** Where a session's latest model request size is kept. */
export const contextUsageNamespace = "memory-agent/context-usage";

const ContextUsage = Schema.Struct({ inputTokens: Schema.Number });
const decodeContextUsage = Schema.decodeUnknownOption(ContextUsage);

export const contextView = (usedTokens: number | null, windowTokens: number): ContextView => ({
  usedTokens,
  windowTokens,
  compactAtTokens: budgetFor(windowTokens).compactAt,
});

/** The tokens the model read in its latest request in a session, if it has made one. */
export const lastInputTokens = async (metadata: MetadataStore, threadId: string) =>
  Option.match(decodeContextUsage(await metadata.get(contextUsageNamespace, threadId)), {
    onNone: () => null,
    onSome: (usage) => usage.inputTokens,
  });

/**
 * Keeps how much each model request of a run read, and tells the page as it happens.
 * `windowTokens` is asked each time, since the window is learned from the model's reports.
 */
export function recordContextUsage(
  metadata: MetadataStore,
  windowTokens: () => number,
): ChatMiddleware {
  return {
    name: "memory-agent/context-usage",
    async onUsage(ctx, usage) {
      await metadata.set(contextUsageNamespace, ctx.threadId, { inputTokens: usage.promptTokens });
      ctx.emitCustomEvent(contextUsageEvent, contextView(usage.promptTokens, windowTokens()));
    },
  };
}
