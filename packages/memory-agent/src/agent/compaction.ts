import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";
import {
  composeStrategies,
  evictOldest,
  withCompaction,
  type CompactionStrategy,
} from "@tanstack/ai-compaction";

/**
 * Estimated tokens of conversation above which what goes to the model is compacted. The models
 * the account offers have a 272k-token context window; this leaves room for the instructions,
 * the tool definitions and the answer.
 */
export const compactAboveTokens = 150_000;

/**
 * Tokens of a message, roughly: English and code take about four characters a token, Korean and
 * other scripts about one. The default estimate (characters / 4) would let Korean text grow far
 * past the budget before anything is compacted.
 */
export function estimateTokens(message: ModelMessage): number {
  const parts = Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.content] : []))
    : [message.content ?? ""];
  const calls = message.toolCalls?.length ? JSON.stringify(message.toolCalls) : "";
  const text = parts.join("") + calls;
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

/** What a cleared tool result says instead of its output. */
export function clearedOutput(nodeId: string | null) {
  return nodeId
    ? `[Tool output cleared to save context. It is kept in memory as node ${nodeId}: call read_evidence with that id to read it again.]`
    : "[Tool output cleared to save context. It is kept in memory: find it with find_memory, then read it with read_evidence.]";
}

/**
 * Clears the output of tool calls the model has already answered from: every tool result before
 * the latest assistant message that called no tools. What follows it (the calls of the run in
 * progress) stays whole, since the model is working with it and a waiting codex turn is handed it.
 * Each cleared result names its memory node, so the model can read it again.
 */
export function clearAnsweredToolResults(
  toolResultIds: () => ReadonlyMap<string, string>,
): CompactionStrategy {
  return (messages) => {
    const answered = messages
      .map((message) => message.role === "assistant" && (message.toolCalls ?? []).length === 0)
      .lastIndexOf(true);
    if (answered < 0) return null;
    let ids: ReadonlyMap<string, string> | null = null;
    let changed = false;
    const next = messages.map((message, index) => {
      if (message.role !== "tool" || index > answered || !message.toolCallId) return message;
      ids ??= toolResultIds();
      const cleared = clearedOutput(ids.get(message.toolCallId) ?? null);
      if (message.content === cleared) return message;
      changed = true;
      return { ...message, content: cleared };
    });
    return changed ? next : null;
  };
}

/** Where dropped messages went, for the model: they are in memory, not gone. */
const droppedMarker = (count: number) =>
  `[${count} earlier messages of this conversation were left out to save context. They are kept in memory: use find_memory, read_evidence and trace_evidence to recall them.]`;

/**
 * Compacts what one session sends to the model once it grows past {@link compactAboveTokens}:
 * first by clearing answered tool output, then, if that is not enough, by leaving out the oldest
 * messages. The saved conversation stays whole; a checkpoint in the chat metadata lets the next
 * run start from the compacted history.
 */
export function compactionFor(
  toolResultIds: () => ReadonlyMap<string, string>,
  maxTokens: number = compactAboveTokens,
): ChatMiddleware {
  return withCompaction({
    maxTokens,
    estimateTokens,
    strategy: composeStrategies(
      clearAnsweredToolResults(toolResultIds),
      evictOldest({ marker: droppedMarker }),
    ),
    // Change it whenever what the strategies write changes, so old checkpoints are not reused.
    strategyKey: "clear-answered-tool-results-v1|evict-oldest-memory-marker-v1",
  });
}
