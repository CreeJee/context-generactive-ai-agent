import type { ChatMiddleware, MetadataStore, ModelMessage } from "@tanstack/ai";
import { evictOldest } from "@tanstack/ai-compaction";
import { Option, Schema } from "effect";
import { recentRawUserTurns } from "./compaction-policy.ts";
import { consumeColdObservation, pendingColdObservation } from "./context-usage.ts";
import type { CompactResult, CompactionStage } from "./run-state.ts";

/**
 * Share of the model's context the conversation may take before it is compacted: answered tool
 * output is cleared first, then earlier turns go as their summaries.
 */
export const compactAtShare = 0.25;
/** Share past which the oldest messages are left out, whatever else was done. */
export const leaveOutAtShare = 0.55;

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
 * calls of the run in progress) stays whole, since the model is still working with it. Each
 * cleared result names its memory node, so the model can read it
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

/**
 * Immutable summaries, one message per stored block. Appending a block never rewrites an earlier
 * message, so the provider can keep the KV prefix through the previous block.
 */
function summaryMessages(blocks: readonly SummaryBlock[]): ModelMessage[] {
  let start = 0;
  return blocks.map((block) => {
    const message: ModelMessage = {
      role: "assistant",
      content: `[Summary of user turns ${start + 1}-${block.end}, written afterwards. The turns themselves were left out to save context and are kept in memory. This summary is a lead, not evidence: read the nodes it cites with read_evidence before relying on a point. Only the user's own words are decisions.]\n\n${block.text}`,
    };
    start = block.end;
    return message;
  });
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
  /**
   * Bounded, variable-tail leads for content this request left out. It must fail closed: compaction
   * still sends the request when retrieval is unavailable.
   */
  readonly retrievalAppendix?: (sent: readonly ModelMessage[]) => Promise<ModelMessage | null>;
}

/** Where dropped messages went, for the model: they are in memory, not gone. */
const droppedMarker = (count: number) =>
  `[${count} earlier messages of this conversation were left out to save context. They are kept in memory: use find_memory, read_evidence and trace_evidence to recall them.]`;
const leaveOutOldest = evictOldest({ marker: droppedMarker });

/** OpenAI rejects a function_call_output when compaction removed its matching function_call. */
function dropOrphanToolResults(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const callIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
    ),
  );
  return messages.filter(
    (message) =>
      message.role !== "tool" ||
      message.toolCallId === undefined ||
      callIds.has(message.toolCallId),
  );
}

export interface Compacted {
  readonly messages: readonly ModelMessage[];
  /** The strongest operation applied while preparing this request. */
  readonly stage: CompactionStage;
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
  early = false,
): Promise<Compacted> {
  // A record for a longer conversation was made for another one.
  const manual = state.manual.clearedThrough <= messages.length ? state.manual : noManualCompaction;
  let sent = messages;
  let stage: CompactionStage = "none";
  const clearedByHand = clearAnswered(
    messages.slice(0, manual.clearedThrough),
    sources.toolResultIds,
  );
  if (clearedByHand) sent = [...clearedByHand, ...messages.slice(manual.clearedThrough)];
  // A completed run no longer needs its tool payload in the next request. This transition happens
  // once; clearAnswered leaves pointers unchanged and never touches the run still in progress.
  const cleared = clearAnswered(sent, sources.toolResultIds);
  if (cleared) sent = cleared;
  if (clearedByHand || cleared) stage = "clear-answered";

  // A valid stored block is a monotonic watermark: once summarized, those turns never come back as
  // raw messages merely because the shorter request fell below the compact threshold.
  const turns = userTurns(messages);
  const fitting = linedUp(messages, state.blocks, sources.nodeText);
  let through = Math.max(manual.summarizedTurns, fitting.at(-1)?.end ?? 0);
  // A reported cache-cold request makes one early attempt even below the normal threshold.
  // Only stored, validated summary blocks can replace raw turns; no content is discarded blindly.
  if (early || estimateConversation(sent) > budget.compactAt)
    through = Math.max(through, turns.length - recentRawUserTurns);
  const summaries = fitting.filter((block) => block.end <= through);
  const summarizedTurns = summaries.at(-1)?.end ?? 0;
  const firstKept = turns[summarizedTurns];
  if (summarizedTurns > 0 && firstKept !== undefined) {
    sent = [...summaryMessages(summaries), ...sent.slice(firstKept)];
    stage = "summarize";
  }

  // Without a ready summary, a one-shot cold hint can still make the next request smaller.
  // Leave the latest two complete user turns intact and point back to the saved conversation.
  if (early && summarizedTurns === 0 && turns.length > recentRawUserTurns) {
    const firstKeptTurn = turns[turns.length - recentRawUserTurns];
    if (firstKeptTurn !== undefined && firstKeptTurn > 0) {
      sent = [
        { role: "assistant", content: droppedMarker(firstKeptTurn) },
        ...sent.slice(firstKeptTurn),
      ];
      stage = "leave-out";
    }
  }

  if (estimateConversation(sent) > budget.leaveOutAt) {
    const leftOut = await leaveOutOldest(sent, {
      maxTokens: budget.leaveOutAt,
      estimate: estimateTokens,
    });
    if (leftOut) {
      sent = leftOut;
      stage = "leave-out";
    }
  }
  // Do not perturb an intact prefix with retrieval. Once this request did omit original content,
  // an optional appendix belongs at its variable tail, immediately before the latest user message,
  // so providers that require user-last requests still accept it. Retrieval is deliberately best-effort.
  if (stage !== "none" && sources.retrievalAppendix) {
    try {
      const appendix = await sources.retrievalAppendix(sent);
      if (appendix) {
        const lastUser = sent.findLastIndex((message) => message.role === "user");
        sent =
          lastUser < 0
            ? [...sent, appendix]
            : [...sent.slice(0, lastUser), appendix, ...sent.slice(lastUser)];
      }
    } catch {
      // Search may be warming or degraded; failure must not prevent the chat request.
    }
  }
  const paired = dropOrphanToolResults(sent);
  if (paired.length !== sent.length) {
    sent = paired;
    if (stage === "none") stage = "clear-answered";
  }
  return { messages: sent, stage, summarizedTurns };
}

const largeShellResult = Schema.parseJson(
  Schema.Struct({
    status: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    durationMs: Schema.Number,
    stdoutTruncated: Schema.Boolean,
    stderrTruncated: Schema.Boolean,
    stdout: Schema.String,
    stderr: Schema.String,
  }),
);
const largeListResult = Schema.parseJson(
  Schema.Struct({
    total: Schema.Number,
    paths: Schema.Array(Schema.String),
    nextOffset: Schema.NullOr(Schema.Number),
    snapshot: Schema.String,
    truncated: Schema.Boolean,
    excludedCredentialFiles: Schema.Number,
  }),
);
const largeSearchResult = Schema.parseJson(
  Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String }),
    ),
    skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
    filesInView: Schema.Number,
    nextCursor: Schema.NullOr(Schema.String),
    complete: Schema.Boolean,
  }),
);
const largeReportResult = Schema.parseJson(
  Schema.Struct({
    status: Schema.String,
    subagentId: Schema.String,
    taskId: Schema.String,
    attemptId: Schema.String,
    agent: Schema.NullOr(Schema.String),
    answer: Schema.String,
    evidenceRefIds: Schema.Array(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
);

/** Purpose-specific provider previews for recorded results; original history stays unchanged. */
export function lightweightToolResults(
  messages: readonly ModelMessage[],
  ids: () => ReadonlyMap<string, string>,
): readonly ModelMessage[] {
  const names = new Map(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => [call.id, call.function.name] as const)
        : [],
    ),
  );
  let recorded: ReadonlyMap<string, string> | null = null;
  return messages.map((message) => {
    if (
      message.role !== "tool" ||
      !message.toolCallId ||
      !Schema.is(Schema.String)(message.content)
    )
      return message;
    const name = names.get(message.toolCallId);
    if (!name || !["run_shell", "list_files", "search_files", "get_subagent_report"].includes(name))
      return message;
    const preview = (text: string, length = 800) => {
      if (text.length <= length) return text;
      const head = Math.ceil(length / 2);
      return `${text.slice(0, head)}… (${text.length - length} omitted characters; full result available by ID) …${text.slice(-Math.floor(length / 2))}`;
    };
    let summary;
    if (name === "run_shell") {
      const result = Option.getOrUndefined(
        Schema.decodeUnknownOption(largeShellResult)(message.content),
      );
      if (!result) return message;
      summary = {
        // The command is already present in the tool call. Avoid echoing it (and the shell path)
        // on every model request; the recorded original remains available by ID.
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        // Successful commands mainly need their outcome; failures retain more diagnostics.
        stdout: preview(result.stdout, result.status === "succeeded" ? 600 : 1_000),
        stderr: preview(result.stderr, result.status === "succeeded" ? 600 : 1_500),
      };
    } else if (name === "list_files") {
      const result = Option.getOrUndefined(
        Schema.decodeUnknownOption(largeListResult)(message.content),
      );
      if (!result) return message;
      summary = {
        ...result,
        paths: result.paths.slice(0, 20),
        shown: Math.min(20, result.paths.length),
      };
    } else if (name === "search_files") {
      const result = Option.getOrUndefined(
        Schema.decodeUnknownOption(largeSearchResult)(message.content),
      );
      if (!result) return message;
      summary = {
        ...result,
        matches: result.matches.slice(0, 8).map((match) => ({
          ...match,
          text: preview(match.text, 180),
        })),
        shown: Math.min(8, result.matches.length),
        skipped: result.skipped.slice(0, 5),
      };
    } else {
      const result = Option.getOrUndefined(
        Schema.decodeUnknownOption(largeReportResult)(message.content),
      );
      if (!result) return message;
      summary = {
        ...result,
        answer: preview(result.answer, 1_200),
        error: result.error === null ? null : preview(result.error, 1_500),
        evidenceRefIds: result.evidenceRefIds.slice(0, 12),
      };
    }
    const serialized = JSON.stringify(summary);
    if (serialized.length >= message.content.length) return message;
    recorded ??= ids();
    const nodeId = recorded.get(message.toolCallId);
    if (!nodeId) return message; // Never promise an ID that has not been recorded.
    const shortened = `[${name} preview; full result: read_tool_result ID ${nodeId}, page by offset. Check omitted entries before relying on them.]\n${serialized}`;
    return shortened.length < message.content.length ? { ...message, content: shortened } : message;
  });
}

/**
 * Compacts what one session sends to the model (see {@link compact}), before every model call of
 * a run. Goes last among the middleware that shape the conversation.
 */
export function compaction(
  metadata: MetadataStore,
  sources: CompactionSources,
  budget: Budget,
  observed: (stage: CompactionStage) => void = () => undefined,
): ChatMiddleware {
  return {
    name: "memory-agent/compaction",
    async onConfig(ctx, config) {
      // Only the model-bound phases shape what is sent.
      if (ctx.phase === "init") return;
      const state = await compactionState(metadata, ctx.threadId);
      const coldId = await pendingColdObservation(metadata, ctx.threadId);
      const { messages, stage } = await compact(
        config.messages,
        state,
        sources,
        budget,
        coldId !== null,
      );
      if (coldId !== null) await consumeColdObservation(metadata, ctx.threadId, coldId);
      observed(stage);
      const providerMessages = lightweightToolResults(messages, sources.toolResultIds);
      return providerMessages.every((message, index) => message === config.messages[index]) &&
        providerMessages.length === config.messages.length
        ? undefined
        : { providerMessages: [...providerMessages] };
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
    (block) => block.end <= userTurns(messages).length - recentRawUserTurns,
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
