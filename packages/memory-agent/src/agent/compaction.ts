import type { ChatMiddleware, MetadataStore, ModelMessage } from "@tanstack/ai";
import { evictOldest } from "@tanstack/ai-compaction";
import { Option, Schema } from "effect";
import type { CompactResult } from "./run-state.ts";

/**
 * Share of the model's context the conversation may take before it is compacted: answered tool
 * output is cleared first, then earlier turns go as their summaries.
 */
export const compactAtShare = 0.25;
/** Share past which the oldest messages are left out, whatever else was done. */
export const leaveOutAtShare = 0.55;
/** The latest user turns, always sent as they are. */
export const keepRecentTurns = 4;

/** Estimated conversation tokens at which each step starts. */
export interface Budget {
  readonly compactAt: number;
  readonly leaveOutAt: number;
}

export const budgetFor = (contextWindow: number): Budget => ({
  compactAt: Math.floor(contextWindow * compactAtShare),
  leaveOutAt: Math.floor(contextWindow * leaveOutAtShare),
});

/** The text of a message, without images or other parts. */
export const messageText = (message: ModelMessage) =>
  Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")
    : (message.content ?? "");

/**
 * Tokens of a message, roughly: English and code take about four characters a token, Korean and
 * other scripts about one. The default estimate (characters / 4) would let Korean text grow far
 * past the budget before anything is compacted.
 */
export function estimateTokens(message: ModelMessage): number {
  const calls = message.toolCalls?.length ? JSON.stringify(message.toolCalls) : "";
  let ascii = 0;
  let other = 0;
  for (const character of messageText(message) + calls) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export const estimateConversation = (messages: readonly ModelMessage[]) =>
  messages.reduce((sum, message) => sum + estimateTokens(message), 0);

const clearedPrefix = "[Tool output cleared to save context.";

/** What a cleared tool result says instead of its output. */
export function clearedOutput(nodeId: string | null) {
  return nodeId
    ? `${clearedPrefix} It is kept in memory as node ${nodeId}: call read_evidence with that id to read it again.]`
    : `${clearedPrefix} It is kept in memory: find it with find_memory, then read it with read_evidence.]`;
}

/** Tool results the model is sent in full. */
const wholeToolOutputs = (messages: readonly ModelMessage[]) =>
  messages.filter(
    (message) => message.role === "tool" && !messageText(message).startsWith(clearedPrefix),
  ).length;

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

/** Where `turnSummaries` keeps a session's summaries. */
export const turnSummariesNamespace = "memory-agent/turn-summaries";

/**
 * A summary of consecutive user turns, from where the previous one ended up to `end` (exclusive,
 * counted from 0). `nextTurnNodeId` is the user node of turn `end`: a conversation whose turn
 * there says something else is not the one summarized, and the summary is not used for it.
 */
export const SummaryBlock = Schema.Struct({
  end: Schema.Number,
  nextTurnNodeId: Schema.String,
  text: Schema.String,
});
export type SummaryBlock = typeof SummaryBlock.Type;
export const StoredSummaries = Schema.Struct({ blocks: Schema.Array(SummaryBlock) });
const decodeSummaries = Schema.decodeUnknownOption(StoredSummaries);

/** Where each user turn of a conversation starts. */
export const userTurns = (messages: readonly ModelMessage[]) =>
  messages.flatMap((message, index) => (message.role === "user" ? [index] : []));

/**
 * Whether a user message is the turn a node recorded. Memory keeps a turn without a pasted key,
 * so a node with a hidden secret matches whatever the message says.
 */
export const sameTurn = (message: ModelMessage | undefined, recorded: string | null) =>
  message?.role === "user" &&
  recorded !== null &&
  (messageText(message) === recorded || recorded.includes("[redacted:"));

/** The summaries that fit this conversation, oldest first, up to the first that does not. */
export function linedUp(
  messages: readonly ModelMessage[],
  blocks: readonly SummaryBlock[],
  nodeText: (id: string) => string | null,
): SummaryBlock[] {
  const turns = userTurns(messages);
  const fitting: SummaryBlock[] = [];
  for (const block of blocks) {
    const previous = fitting.at(-1)?.end ?? 0;
    const next = turns[block.end];
    if (block.end <= previous || next === undefined) break;
    if (!sameTurn(messages[next], nodeText(block.nextTurnNodeId))) break;
    fitting.push(block);
  }
  return fitting;
}

/** The summaries, sent in place of the turns they cover. */
function summaryMessage(blocks: readonly SummaryBlock[]): ModelMessage {
  let start = 0;
  const parts = blocks.map((block) => {
    const part = `Turns ${start + 1}-${block.end}:\n${block.text}`;
    start = block.end;
    return part;
  });
  return {
    role: "assistant",
    content: `[Summary of the first ${start} user turns of this conversation, written afterwards. The turns themselves were left out to save context and are kept in memory. The summary is a lead, not evidence: read the nodes it cites with read_evidence before relying on a point. Only the user's own words are decisions.]\n\n${parts.join("\n\n")}`,
  };
}

/** Where `/compact` records how far it compacted a session's conversation. */
export const manualCompactionNamespace = "memory-agent/manual-compaction";

/**
 * After `/compact`: the answered tool output of the first `clearedThrough` messages, and the first
 * `summarizedTurns` turns (as their summaries), are never sent as they were.
 */
const ManualCompaction = Schema.Struct({
  clearedThrough: Schema.Number,
  summarizedTurns: Schema.optionalWith(Schema.Number, { default: () => 0 }),
});
type ManualCompaction = typeof ManualCompaction.Type;
const decodeManualCompaction = Schema.decodeUnknownOption(ManualCompaction);
const noManualCompaction: ManualCompaction = { clearedThrough: 0, summarizedTurns: 0 };

/** What is stored about compacting one session. */
export interface CompactionState {
  readonly manual: ManualCompaction;
  readonly blocks: readonly SummaryBlock[];
}

export async function compactionState(
  metadata: MetadataStore,
  threadId: string,
): Promise<CompactionState> {
  const [manual, summaries] = await Promise.all([
    metadata.get(manualCompactionNamespace, threadId),
    metadata.get(turnSummariesNamespace, threadId),
  ]);
  return {
    manual: Option.getOrElse(decodeManualCompaction(manual), () => noManualCompaction),
    blocks: Option.match(decodeSummaries(summaries), {
      onNone: () => [],
      onSome: (stored) => stored.blocks,
    }),
  };
}

/** How the session's memory answers what compaction asks. */
export interface CompactionSources {
  /** The session's tool_result node ids, by tool call id. */
  readonly toolResultIds: () => ReadonlyMap<string, string>;
  readonly nodeText: (id: string) => string | null;
}

/** Where dropped messages went, for the model: they are in memory, not gone. */
const droppedMarker = (count: number) =>
  `[${count} earlier messages of this conversation were left out to save context. They are kept in memory: use find_memory, read_evidence and trace_evidence to recall them.]`;
const leaveOutOldest = evictOldest({ marker: droppedMarker });

export interface Compacted {
  readonly messages: readonly ModelMessage[];
  /** The user turns sent as their summaries. */
  readonly summarizedTurns: number;
}

/**
 * The conversation as the model is sent it. What `/compact` did always applies. Past
 * `compactAt` the answered tool output is cleared, and if that is not enough, the turns before
 * the latest few go as their summaries, as far as summaries exist. Past `leaveOutAt` the oldest
 * messages are left out. The saved conversation itself is never changed.
 */
export async function compact(
  messages: readonly ModelMessage[],
  state: CompactionState,
  sources: CompactionSources,
  budget: Budget,
): Promise<Compacted> {
  // A record for a longer conversation was made for another one.
  const manual = state.manual.clearedThrough <= messages.length ? state.manual : noManualCompaction;
  let sent = messages;
  const clearedByHand = clearAnswered(
    messages.slice(0, manual.clearedThrough),
    sources.toolResultIds,
  );
  if (clearedByHand) sent = [...clearedByHand, ...messages.slice(manual.clearedThrough)];
  if (estimateConversation(sent) > budget.compactAt)
    sent = clearAnswered(sent, sources.toolResultIds) ?? sent;

  // Clearing keeps every message in place, so turns still count from the saved conversation.
  const turns = userTurns(messages);
  let through = manual.summarizedTurns;
  if (estimateConversation(sent) > budget.compactAt)
    through = Math.max(through, turns.length - keepRecentTurns);
  const summaries = linedUp(messages, state.blocks, sources.nodeText).filter(
    (block) => block.end <= through,
  );
  const summarizedTurns = summaries.at(-1)?.end ?? 0;
  const firstKept = turns[summarizedTurns];
  if (summarizedTurns > 0 && firstKept !== undefined)
    sent = [summaryMessage(summaries), ...sent.slice(firstKept)];

  if (estimateConversation(sent) > budget.leaveOutAt)
    sent =
      (await leaveOutOldest(sent, { maxTokens: budget.leaveOutAt, estimate: estimateTokens })) ??
      sent;
  return { messages: sent, summarizedTurns };
}

/**
 * Compacts what one session sends to the model (see {@link compact}), before every model call of
 * a run. Goes last among the middleware that shape the conversation.
 */
export function compaction(
  metadata: MetadataStore,
  sources: CompactionSources,
  budget: Budget,
): ChatMiddleware {
  return {
    name: "memory-agent/compaction",
    async onConfig(ctx, config) {
      // Only the model-bound phases shape what is sent.
      if (ctx.phase === "init") return;
      const state = await compactionState(metadata, ctx.threadId);
      const { messages } = await compact(config.messages, state, sources, budget);
      return messages === config.messages ? undefined : { providerMessages: [...messages] };
    },
  };
}

/** How summarizing went before `/compact`. */
export type SummaryOutcome = "done" | "failed" | "unavailable";

/**
 * `/compact`: summarizes what has not been yet (`summarize`), then clears the output of every tool
 * call the model has answered from and sends the turns before the latest few as their summaries,
 * whatever the budget, for this and every later run.
 */
export async function compactByHand(
  metadata: MetadataStore,
  threadId: string,
  messages: readonly ModelMessage[],
  sources: CompactionSources,
  budget: Budget,
  summarize: () => Promise<SummaryOutcome>,
): Promise<CompactResult> {
  const before = await compact(
    messages,
    await compactionState(metadata, threadId),
    sources,
    budget,
  );
  const outcome = await summarize();
  const state = await compactionState(metadata, threadId);
  const summaries = linedUp(messages, state.blocks, sources.nodeText).filter(
    (block) => block.end <= userTurns(messages).length - keepRecentTurns,
  );
  const manual: ManualCompaction = {
    clearedThrough: messages.length,
    summarizedTurns: summaries.at(-1)?.end ?? 0,
  };
  await metadata.set(manualCompactionNamespace, threadId, manual);
  const after = await compact(messages, { ...state, manual }, sources, budget);
  return {
    cleared: Math.max(0, wholeToolOutputs(before.messages) - wholeToolOutputs(after.messages)),
    summarizedTurns: Math.max(0, after.summarizedTurns - before.summarizedTurns),
    summaryFailed: outcome !== "done",
    tokensBefore: estimateConversation(before.messages),
    tokensAfter: estimateConversation(after.messages),
  };
}
