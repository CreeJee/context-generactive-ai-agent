import type { ChatMiddleware, MetadataStore, ModelMessage } from "@tanstack/ai";
import {
  composeStrategies,
  evictOldest,
  withCompaction,
  type CompactionStrategy,
} from "@tanstack/ai-compaction";
import { Option, Schema } from "effect";
import type { CompactResult } from "./run-state.ts";

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

const totalTokens = (messages: readonly ModelMessage[]) =>
  messages.reduce((sum, message) => sum + estimateTokens(message), 0);

/** What a cleared tool result says instead of its output. */
export function clearedOutput(nodeId: string | null) {
  return nodeId
    ? `[Tool output cleared to save context. It is kept in memory as node ${nodeId}: call read_evidence with that id to read it again.]`
    : "[Tool output cleared to save context. It is kept in memory: find it with find_memory, then read it with read_evidence.]";
}

/**
 * The messages with the output of tool calls the model has already answered from cleared: every
 * tool result before the latest assistant message that called no tools. What follows it (the
 * calls of the run in progress) stays whole, since the model is working with it and a waiting
 * codex turn is handed it. Each cleared result names its memory node, so the model can read it
 * again. Null when there is nothing to clear.
 */
function clearAnswered(
  messages: readonly ModelMessage[],
  toolResultIds: () => ReadonlyMap<string, string>,
): ModelMessage[] | null {
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
}

/** {@link clearAnswered} as a compaction strategy. */
export function clearAnsweredToolResults(
  toolResultIds: () => ReadonlyMap<string, string>,
): CompactionStrategy {
  return (messages) => clearAnswered(messages, toolResultIds);
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

/** Where `/compact` records how much of a session's conversation it compacted. */
export const manualCompactionNamespace = "memory-agent/manual-compaction";

/** The answered tool output of the first `clearedThrough` messages is never sent again. */
const ManualCompaction = Schema.Struct({ clearedThrough: Schema.Number });
const decodeManualCompaction = Schema.decodeUnknownOption(ManualCompaction);

/** The conversation as the model is sent it after a `/compact` that covered `clearedThrough`. */
function afterManual(
  messages: readonly ModelMessage[],
  clearedThrough: number,
  toolResultIds: () => ReadonlyMap<string, string>,
): readonly ModelMessage[] {
  // A thread shorter than the record is not the one it was made for.
  if (clearedThrough > messages.length) return messages;
  const prefix = clearAnswered(messages.slice(0, clearedThrough), toolResultIds);
  return prefix ? [...prefix, ...messages.slice(clearedThrough)] : messages;
}

const clearedThroughOf = async (metadata: MetadataStore, threadId: string) =>
  Option.match(decodeManualCompaction(await metadata.get(manualCompactionNamespace, threadId)), {
    onNone: () => 0,
    onSome: (stored) => stored.clearedThrough,
  });

/**
 * Keeps what `/compact` cleared out of every later model call. Goes before
 * {@link compactionFor}, which compacts further when the rest still grows past the budget.
 */
export function manualCompaction(
  metadata: MetadataStore,
  toolResultIds: () => ReadonlyMap<string, string>,
): ChatMiddleware {
  return {
    name: "memory-agent/manual-compaction",
    async onConfig(ctx, config) {
      // Like withCompaction: only the model-bound phases shape what is sent.
      if (ctx.phase === "init") return;
      const clearedThrough = await clearedThroughOf(metadata, ctx.threadId);
      if (clearedThrough === 0) return;
      const sent = afterManual(config.messages, clearedThrough, toolResultIds);
      return sent === config.messages ? undefined : { providerMessages: [...sent] };
    },
  };
}

/**
 * `/compact`: clears the output of every tool call the model has answered from, whatever the
 * budget, and keeps it cleared for the runs that follow.
 */
export async function compactByHand(
  metadata: MetadataStore,
  threadId: string,
  messages: readonly ModelMessage[],
  toolResultIds: () => ReadonlyMap<string, string>,
): Promise<CompactResult> {
  const sentBefore = afterManual(
    messages,
    await clearedThroughOf(metadata, threadId),
    toolResultIds,
  );
  const sentAfter = afterManual(messages, messages.length, toolResultIds);
  const cleared = sentAfter.filter(
    (message, index) => message.role === "tool" && message.content !== sentBefore[index]?.content,
  ).length;
  await metadata.set(manualCompactionNamespace, threadId, { clearedThrough: messages.length });
  return {
    cleared,
    tokensBefore: totalTokens(sentBefore),
    tokensAfter: totalTokens(sentAfter),
  };
}
