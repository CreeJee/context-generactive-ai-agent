import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import type { ChatMiddleware, MetadataStore, ModelMessage } from "@tanstack/ai";
import { evictOldest } from "@tanstack/ai-compaction";
import {
  Array as EffectArray,
  MutableHashMap,
  MutableHashSet,
  Effect,
  Option,
  Schema,
} from "effect";
import { recentRawUserTurns } from "./compaction-policy.ts";
import { consumeColdObservationEffect, pendingColdObservationEffect } from "./context-usage.ts";
import type { CompactResult, CompactionStage } from "./run-state.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import type { NodeStoreFailed } from "../memory/nodes.ts";

export class CompactionFailed extends Schema.TaggedError<CompactionFailed>()("CompactionFailed", {
  operation: Schema.Literals([
    "prepare-before",
    "read-state",
    "persist",
    "prepare-after",
    "history",
    "read-cold",
    "consume-cold",
    "read-memory",
  ]),
  reason: Schema.Union([
    Schema.TaggedStruct("MetadataFailed", {}),
    Schema.TaggedStruct("EvictionFailed", {}),
    Schema.TaggedStruct("RetrievalFailed", {}),
    Schema.TaggedStruct("HistoryFailed", {}),
    Schema.TaggedStruct("MemoryFailed", {}),
  ]),
  cause: Schema.Defect(),
}) {}

const compactionPromise = <A>(options: {
  readonly operation: CompactionFailed["operation"];
  readonly reason: CompactionFailed["reason"]["_tag"];
  readonly evaluate: () => PromiseLike<A>;
}) =>
  Effect.tryPromise({
    try: options.evaluate,
    catch: (cause) =>
      CompactionFailed.make({
        operation: options.operation,
        reason: { _tag: options.reason },
        cause,
      }),
  });

/** Share past which the oldest messages are left out, whatever else was done. */
export const leaveOutAtShare = 0.55;

/** Estimated leave-out ceiling; compactAt is retained as a zero-valued compatibility field. */
export interface Budget {
  /** @deprecated Validated summaries and answered tools compact without a minimum threshold. */
  readonly compactAt: number;
  readonly leaveOutAt: number;
}

export const budgetFor = (contextWindow: number): Budget => ({
  compactAt: 0,
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
  const calls = isTruthy(message.toolCalls?.length) ? JSON.stringify(message.toolCalls) : "";
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
  return isTruthy(nodeId)
    ? `${clearedPrefix} It is kept in memory as node ${nodeId}: call read_evidence with that id to read it again.]`
    : `${clearedPrefix} It is kept in memory: find it with find_memory, then read it with read_evidence.]`;
}

/** Tool results the model is sent in full. */
const wholeToolOutputs = (messages: readonly ModelMessage[]) =>
  messages.filter(
    (message) => message.role === "tool" && !messageText(message).startsWith(clearedPrefix),
  ).length;

/**
 * The messages with the output of tool calls the model has already answered from cleared. The
 * answered part ends at the latest assistant message that called no tools; what follows it (the
 * calls of the run in progress) stays whole, since the model is still working with it.
 *
 * `keepLatestAnswered` also keeps the turn that answer belongs to whole: the next request is
 * usually about what that run just read, and re-reading it would cost a tool round trip. That
 * turn is cleared once the following run has answered, so each tool result changes exactly once
 * and the request prefix before it stays cacheable. An explicit `/compact` clears everything
 * answered. Each cleared result names its memory node, so the model can read it again. Null when
 * there is nothing to clear.
 */
function clearAnswered(
  messages: readonly ModelMessage[],
  toolResultId: (toolCallId: string) => string | null,
  keepLatestAnswered: boolean,
): ModelMessage[] | null {
  const answered = messages
    .map((message) => message.role === "assistant" && (message.toolCalls ?? []).length === 0)
    .lastIndexOf(true);
  if (answered < 0) return null;
  const end = keepLatestAnswered
    ? messages.slice(0, answered + 1).findLastIndex((message) => message.role === "user")
    : answered + 1;
  if (end <= 0) return null;
  let changed = false;
  const next = messages.map((message, index) => {
    if (message.role !== "tool" || index >= end || !isTruthy(message.toolCallId)) return message;
    const cleared = clearedOutput(toolResultId(message.toolCallId));
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
  end: Schema.Finite,
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
const sameTurnBody = (message: ModelMessage | undefined, recorded: string | null) =>
  message?.role === "user" &&
  recorded !== null &&
  (messageText(message) === recorded || recorded.includes("[redacted:"));
export const sameTurn: {
  (recorded: string | null): (message: ModelMessage | undefined) => ReturnType<typeof sameTurnBody>;
} & typeof sameTurnBody = EffectFunction.dual(2, sameTurnBody);

/** The summaries that fit this conversation, oldest first, up to the first that does not. */
export const linedUp: {
  (
    blocks: readonly SummaryBlock[],
    nodeText: (id: string) => string | null,
  ): (messages: readonly ModelMessage[]) => ReturnType<typeof linedUpBody>;
} & typeof linedUpBody = EffectFunction.dual(3, linedUpBody);
function linedUpBody(
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
  clearedThrough: Schema.Finite,
  summarizedTurns: Schema.Finite.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(0))),
});
type ManualCompaction = typeof ManualCompaction.Type;
const decodeManualCompaction = Schema.decodeUnknownOption(ManualCompaction);
const noManualCompaction: ManualCompaction = { clearedThrough: 0, summarizedTurns: 0 };

/** What is stored about compacting one session. */
export interface CompactionState {
  readonly manual: ManualCompaction;
  readonly blocks: readonly SummaryBlock[];
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const compactionState: {
  (threadId: string): (metadata: MetadataStore) => ReturnType<typeof compactionStateBody>;
} & typeof compactionStateBody = EffectFunction.dual(2, compactionStateBody);
function compactionStateBody(metadata: MetadataStore, threadId: string): Promise<CompactionState> {
  return Effect.runPromise(compactionStateEffect({ metadata, threadId }));
}

export const compactionStateEffect = Effect.fnUntraced(function* (options: {
  readonly metadata: MetadataStore;
  readonly threadId: string;
}) {
  const { metadata, threadId } = options;
  const [manual, summaries] = yield* Effect.all(
    [
      compactionPromise({
        operation: "read-state",
        reason: "MetadataFailed",
        evaluate: () => metadata.get(manualCompactionNamespace, threadId),
      }),
      compactionPromise({
        operation: "read-state",
        reason: "MetadataFailed",
        evaluate: () => metadata.get(turnSummariesNamespace, threadId),
      }),
    ],
    { concurrency: "unbounded" },
  );
  return {
    manual: Option.getOrElse(decodeManualCompaction(manual), () => noManualCompaction),
    blocks: Option.match(decodeSummaries(summaries), {
      onNone: () => [],
      onSome: (stored) => stored.blocks,
    }),
  };
});

/** How the session's memory answers what compaction asks. */
export interface CompactionSources {
  /** The first recorded tool_result node id of each of these tool calls that has one. */
  readonly toolResultIds: (
    toolCallIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, NodeStoreFailed>;
  /** The recorded text of each of these nodes that exists. */
  readonly nodeTexts: (
    ids: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, NodeStoreFailed>;
  /**
   * Bounded, variable-tail leads for content this request left out. It must fail closed: compaction
   * still sends the request when retrieval is unavailable.
   */
  readonly retrievalAppendix?: (sent: readonly ModelMessage[]) => Promise<ModelMessage | null>;
}

/** Sources answered from lookups already in memory, as evaluations and fixtures have them. */
export const lookupSources = (lookups: {
  readonly toolResultId: (toolCallId: string) => string | null;
  readonly nodeText: (id: string) => string | null;
}): CompactionSources => {
  const found = (ids: readonly string[], lookup: (id: string) => string | null) =>
    Effect.sync(
      () =>
        new Map(
          ids.flatMap((id) => {
            const value = lookup(id);
            return value === null ? [] : [[id, value] as const];
          }),
        ),
    );
  return {
    toolResultIds: (ids) => found(ids, lookups.toolResultId),
    nodeTexts: (ids) => found(ids, lookups.nodeText),
  };
};

/** The tool calls these messages answer. */
export const answeredToolCalls = (messages: readonly ModelMessage[]) =>
  EffectArray.dedupe(
    messages.flatMap((message) =>
      message.role === "tool" && isTruthy(message.toolCallId) ? [message.toolCallId] : [],
    ),
  );

/**
 * What memory recorded for these messages and summary blocks, read once so compaction can decide
 * synchronously.
 */
export const memoryLookups = Effect.fnUntraced(function* (
  sources: CompactionSources,
  messages: readonly ModelMessage[],
  blocks: readonly SummaryBlock[],
) {
  const [results, texts] = yield* Effect.all([
    sources.toolResultIds(answeredToolCalls(messages)),
    sources.nodeTexts(EffectArray.dedupe(blocks.map((block) => block.nextTurnNodeId))),
  ]).pipe(
    Effect.mapError((cause) =>
      CompactionFailed.make({ operation: "read-memory", reason: { _tag: "MemoryFailed" }, cause }),
    ),
  );
  return {
    toolResultId: (toolCallId: string) => results.get(toolCallId) ?? null,
    nodeText: (id: string) => texts.get(id) ?? null,
  };
});

/** Where dropped messages went, for the model: they are in memory, not gone. */
const droppedMarker = (count: number) =>
  `[${count} earlier messages of this conversation were left out to save context. They are kept in memory: use find_memory, read_evidence and trace_evidence to recall them.]`;
const leaveOutOldest = evictOldest({ marker: droppedMarker });

const decodeToolArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Partial historical calls cannot be replayed; keep the stored transcript intact. */
export function replayableToolHistory(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const replayable = messages.map((message) => {
    if (message.role !== "assistant" || !isTruthy(message.toolCalls?.length)) return message;
    const toolCalls = message.toolCalls.filter((call) =>
      Option.isSome(decodeToolArguments(call.function.arguments)),
    );
    return toolCalls.length === message.toolCalls.length ? message : { ...message, toolCalls };
  });
  // A result cannot be sent without its replayable matching call.
  const callIds = MutableHashSet.fromIterable(
    replayable.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
    ),
  );
  return replayable.filter(
    (message) =>
      message.role !== "tool" ||
      message.toolCallId === undefined ||
      MutableHashSet.has(callIds, message.toolCallId),
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
 * The conversation as the model is sent it. Answered tool outputs become pointers after a run,
 * and validated older summary blocks replace raw turns regardless of conversation size. Past
 * `leaveOutAt` the oldest messages are left out. The saved conversation is never changed.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function compactBody(
  messages: readonly ModelMessage[],
  state: CompactionState,
  sources: CompactionSources,
  budget: Budget,
  early = false,
): Promise<Compacted> {
  return Effect.runPromise(compactEffect({ messages, state, sources, budget, early }));
}

export const compact: {
  (
    messages: readonly ModelMessage[],
    state: CompactionState,
    sources: CompactionSources,
    budget: Budget,
  ): Promise<Compacted>;
  (
    messages: readonly ModelMessage[],
    state: CompactionState,
    sources: CompactionSources,
    budget: Budget,
    early: boolean | undefined,
  ): Promise<Compacted>;
  (
    state: CompactionState,
    sources: CompactionSources,
    budget: Budget,
  ): (messages: readonly ModelMessage[]) => Promise<Compacted>;
  (
    state: CompactionState,
    sources: CompactionSources,
    budget: Budget,
    early: boolean | undefined,
  ): (messages: readonly ModelMessage[]) => Promise<Compacted>;
} = EffectFunction.dual((args) => Array.isArray(args[0]), compactBody);

export const compactEffect = Effect.fnUntraced(function* (options: {
  readonly messages: readonly ModelMessage[];
  readonly state: CompactionState;
  readonly sources: CompactionSources;
  readonly budget: Budget;
  readonly early?: boolean;
}) {
  const { messages, state, sources, budget, early = false } = options;
  // A record for a longer conversation was made for another one.
  const manual = state.manual.clearedThrough <= messages.length ? state.manual : noManualCompaction;
  let sent = messages;
  let stage: CompactionStage = "none";
  const { toolResultId, nodeText } = yield* memoryLookups(sources, messages, state.blocks);
  const clearedByHand = clearAnswered(
    messages.slice(0, manual.clearedThrough),
    toolResultId,
    false,
  );
  if (clearedByHand !== null) sent = [...clearedByHand, ...messages.slice(manual.clearedThrough)];
  // An answered run's tool payload is cleared once the run after it has answered too. This
  // transition happens once; clearAnswered leaves pointers unchanged and never touches the run
  // still in progress.
  const cleared = clearAnswered(sent, toolResultId, true);
  if (cleared !== null) sent = cleared;
  if (clearedByHand !== null || cleared !== null) stage = "clear-answered";

  // Stored, validated blocks are monotonic: even a small request keeps earlier turns summarized.
  // The previous 25% gate could not change the chosen blocks: through always started at the end
  // of fitting, so filtering fitting by through always returned every validated block.
  const turns = userTurns(messages);
  const summaries = linedUp(messages, state.blocks, nodeText);
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

  // Results that cannot be replayed are dropped anyway; measured with them, a request whose
  // history holds large unreplayable output would leave out messages it has room for.
  const pair = () => {
    const paired = replayableToolHistory(sent);
    if (paired.length !== sent.length || paired.some((message, index) => message !== sent[index])) {
      sent = paired;
      if (stage === "none") stage = "clear-answered";
    }
  };
  pair();
  if (estimateConversation(sent) > budget.leaveOutAt) {
    const leftOut = yield* compactionPromise({
      operation: "prepare-before",
      reason: "EvictionFailed",
      evaluate: () =>
        Promise.resolve(
          leaveOutOldest(sent, {
            maxTokens: budget.leaveOutAt,
            estimate: estimateTokens,
          }),
        ),
    });
    if (isTruthy(leftOut)) {
      sent = leftOut;
      stage = "leave-out";
    }
  }
  // Do not perturb an intact prefix with retrieval. Once this request did omit original content,
  // an optional appendix belongs at its variable tail, immediately before the latest user message,
  // so providers that require user-last requests still accept it. Retrieval is deliberately best-effort.
  if (stage !== "none" && sources.retrievalAppendix !== undefined) {
    const retrieve = sources.retrievalAppendix;
    const appendix = yield* compactionPromise({
      operation: "prepare-before",
      reason: "RetrievalFailed",
      evaluate: () => retrieve(sent),
    }).pipe(Effect.catchReason("CompactionFailed", "RetrievalFailed", () => Effect.succeed(null)));
    if (isTruthy(appendix)) {
      const lastUser = sent.findLastIndex((message) => message.role === "user");
      sent =
        lastUser < 0
          ? [...sent, appendix]
          : [...sent.slice(0, lastUser), appendix, ...sent.slice(lastUser)];
    }
  }

  // Leaving out the oldest messages can split a call from its result.
  pair();
  return { messages: sent, stage, summarizedTurns };
});

const largeShellResult = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    exitCode: Schema.NullOr(Schema.Finite),
    signal: Schema.NullOr(Schema.String),
    durationMs: Schema.Finite,
    stdoutTruncated: Schema.Boolean,
    stderrTruncated: Schema.Boolean,
    stdout: Schema.String,
    stderr: Schema.String,
  }),
);
const largeListResult = Schema.fromJsonString(
  Schema.Struct({
    total: Schema.Finite,
    paths: Schema.Array(Schema.String),
    nextOffset: Schema.NullOr(Schema.Finite),
    snapshot: Schema.String,
    truncated: Schema.Boolean,
    excludedCredentialFiles: Schema.Finite,
  }),
);
const largeSearchResult = Schema.fromJsonString(
  Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({ path: Schema.String, line: Schema.Finite, text: Schema.String }),
    ),
    skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
    filesInView: Schema.Finite,
    nextCursor: Schema.NullOr(Schema.String),
    complete: Schema.Boolean,
  }),
);
const largeReportResult = Schema.fromJsonString(
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
export const lightweightToolResults: {
  (
    toolResultId: (toolCallId: string) => string | null,
  ): (messages: readonly ModelMessage[]) => ReturnType<typeof lightweightToolResultsBody>;
} & typeof lightweightToolResultsBody = EffectFunction.dual(2, lightweightToolResultsBody);
function lightweightToolResultsBody(
  messages: readonly ModelMessage[],
  toolResultId: (toolCallId: string) => string | null,
): readonly ModelMessage[] {
  const names = MutableHashMap.fromIterable(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => [call.id, call.function.name] as const)
        : [],
    ),
  );
  return messages.map((message) => {
    if (
      message.role !== "tool" ||
      !isTruthy(message.toolCallId) ||
      !Schema.is(Schema.String)(message.content)
    )
      return message;
    const name = Option.getOrUndefined(MutableHashMap.get(names, message.toolCallId));
    if (
      !isTruthy(name) ||
      !["run_skill", "run_shell", "list_files", "search_files", "get_subagent_report"].includes(
        name,
      )
    )
      return message;
    const preview = (text: string, length = 800) => {
      if (text.length <= length) return text;
      const head = Math.ceil(length / 2);
      return `${text.slice(0, head)}… (${text.length - length} omitted characters; full result available by ID) …${text.slice(-Math.floor(length / 2))}`;
    };
    let summary;
    if (name === "run_skill" || name === "run_shell") {
      const result = Option.getOrUndefined(Schema.decodeOption(largeShellResult)(message.content));
      if (!isTruthy(result)) return message;
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
      const result = Option.getOrUndefined(Schema.decodeOption(largeListResult)(message.content));
      if (!isTruthy(result)) return message;
      summary = {
        ...result,
        paths: result.paths.slice(0, 20),
        shown: Math.min(20, result.paths.length),
      };
    } else if (name === "search_files") {
      const result = Option.getOrUndefined(Schema.decodeOption(largeSearchResult)(message.content));
      if (!isTruthy(result)) return message;
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
      const result = Option.getOrUndefined(Schema.decodeOption(largeReportResult)(message.content));
      if (!isTruthy(result)) return message;
      summary = {
        ...result,
        answer: preview(result.answer, 1_200),
        error: result.error === null ? null : preview(result.error, 1_500),
        evidenceRefIds: result.evidenceRefIds.slice(0, 12),
      };
    }
    const serialized = JSON.stringify(summary);
    if (serialized.length >= message.content.length) return message;
    const nodeId = toolResultId(message.toolCallId);
    if (!isTruthy(nodeId)) return message; // Never promise an ID that has not been recorded.
    const shortened = `[${name} preview; full result: read_tool_result ID ${nodeId}, page by offset. Check omitted entries before relying on them.]\n${serialized}`;
    return shortened.length < message.content.length ? { ...message, content: shortened } : message;
  });
}

/**
 * Compacts what one session sends to the model (see {@link compact}), before every model call of
 * a run. Goes last among the middleware that shape the conversation.
 */
function compactionBody(
  metadata: MetadataStore,
  sources: CompactionSources,
  budget: Budget,
  observed: (stage: CompactionStage) => void = () => undefined,
  historyForModel?: (messages: readonly ModelMessage[]) => Promise<readonly ModelMessage[] | null>,
): ChatMiddleware {
  return {
    name: "memory-agent/compaction",
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onConfig: (ctx, config) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (ctx.phase === "init") {
            const restored =
              historyForModel === undefined
                ? null
                : yield* compactionPromise({
                    operation: "history",
                    reason: "HistoryFailed",
                    evaluate: () => historyForModel(config.messages),
                  });
            if (!isTruthy(restored)) return;
            const replayed = MutableHashSet.fromIterable(
              restored.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
            );
            const answered = MutableHashSet.fromIterable(
              config.messages
                .filter((message) => message.role === "tool")
                .map((message) => message.toolCallId),
            );
            const approvals = config.resumeToolState?.approvals;
            const abandoned = config.messages.flatMap((message) =>
              (message.toolCalls ?? [])
                .filter(
                  (call) =>
                    !MutableHashSet.has(replayed, call.id) &&
                    !MutableHashSet.has(answered, call.id) &&
                    !isTruthy(approvals?.has(call.id)) &&
                    !isTruthy(approvals?.has(`approval_${call.id}`)),
                )
                .map((call) => call.id),
            );
            if (abandoned.length === 0) return;
            return {
              resumeToolState: {
                ...config.resumeToolState,
                cancelledToolCallIds: new Set([
                  ...(config.resumeToolState?.cancelledToolCallIds ?? []),
                  ...abandoned,
                ]),
              },
            };
          }
          const state = yield* compactionStateEffect({ metadata, threadId: ctx.threadId });
          const coldId = yield* pendingColdObservationEffect({
            metadata,
            threadId: ctx.threadId,
          }).pipe(
            Effect.mapError((failure) =>
              CompactionFailed.make({
                operation: "read-cold",
                reason: { _tag: "MetadataFailed" },
                cause: failure.cause,
              }),
            ),
          );
          const restored =
            historyForModel === undefined
              ? null
              : yield* compactionPromise({
                  operation: "history",
                  reason: "HistoryFailed",
                  evaluate: () => historyForModel(config.messages),
                });
          const removedTurns = isTruthy(restored)
            ? userTurns(config.messages).length - userTurns(restored).length
            : 0;
          const restoredContext = restored?.[0];
          const { messages, stage } = yield* compactEffect({
            messages: isTruthy(restored) ? restored.slice(1) : config.messages,
            state: isTruthy(restored)
              ? {
                  manual: noManualCompaction,
                  blocks: state.blocks
                    .filter((block) => block.end > removedTurns)
                    .map((block) => ({ ...block, end: block.end - removedTurns })),
                }
              : state,
            sources,
            budget: isTruthy(restoredContext)
              ? {
                  ...budget,
                  leaveOutAt: Math.max(1, budget.leaveOutAt - estimateTokens(restoredContext)),
                }
              : budget,
            early: coldId !== null,
          });
          if (coldId !== null)
            yield* consumeColdObservationEffect({
              metadata,
              threadId: ctx.threadId,
              observationId: coldId,
            }).pipe(
              Effect.mapError((failure) =>
                CompactionFailed.make({
                  operation: "consume-cold",
                  reason: { _tag: "MetadataFailed" },
                  cause: failure.cause,
                }),
              ),
            );
          observed(isTruthy(restored) && stage === "none" ? "summarize" : stage);
          const question = restored?.findLast(
            (message) => message.role === "user" && messageText(message).trim(),
          );
          const retained =
            isTruthy(question) && !messages.includes(question) ? [question, ...messages] : messages;
          const outgoing = isTruthy(restoredContext) ? [restoredContext, ...retained] : messages;
          const { toolResultId } = yield* memoryLookups(sources, outgoing, []);
          const providerMessages = lightweightToolResults(outgoing, toolResultId).filter(
            (message) => !isEmptyUserText(message),
          );
          return providerMessages.every((message, index) => message === config.messages[index]) &&
            providerMessages.length === config.messages.length
            ? undefined
            : { providerMessages: [...providerMessages] };
        }),
        { signal: ctx.signal },
      ),
  };
}

const isBudget = Schema.is(Schema.Struct({ compactAt: Schema.Finite, leaveOutAt: Schema.Finite }));
type CompactionObserver = ((stage: CompactionStage) => void) | undefined;
type HistoryForModel =
  | ((messages: readonly ModelMessage[]) => Promise<readonly ModelMessage[] | null>)
  | undefined;
export const compaction: {
  (metadata: MetadataStore, sources: CompactionSources, budget: Budget): ChatMiddleware;
  (
    metadata: MetadataStore,
    sources: CompactionSources,
    budget: Budget,
    observed: CompactionObserver,
  ): ChatMiddleware;
  (
    metadata: MetadataStore,
    sources: CompactionSources,
    budget: Budget,
    observed: CompactionObserver,
    historyForModel: HistoryForModel,
  ): ChatMiddleware;
  (sources: CompactionSources, budget: Budget): (metadata: MetadataStore) => ChatMiddleware;
  (
    sources: CompactionSources,
    budget: Budget,
    observed: CompactionObserver,
  ): (metadata: MetadataStore) => ChatMiddleware;
  (
    sources: CompactionSources,
    budget: Budget,
    observed: CompactionObserver,
    historyForModel: HistoryForModel,
  ): (metadata: MetadataStore) => ChatMiddleware;
} = EffectFunction.dual((args) => isBudget(args[2]), compactionBody);

/** How summarizing went before `/compact`. */
export type SummaryOutcome = "done" | "failed" | "unavailable";

/**
 * `/compact`: summarizes what has not been yet (`summarize`), then clears the output of every tool
 * call the model has answered from and sends the turns before the latest few as their summaries,
 * whatever the budget, for this and every later run.
 */
const compactByHandBody = <E>(
  metadata: MetadataStore,
  threadId: string,
  messages: readonly ModelMessage[],
  sources: CompactionSources,
  budget: Budget,
  summarize: () => Effect.Effect<SummaryOutcome, E>,
): Effect.Effect<CompactResult, CompactionFailed | E> =>
  Effect.gen(function* () {
    const initial = yield* compactionStateEffect({ metadata, threadId });
    const before = yield* compactEffect({ messages, state: initial, sources, budget });
    const outcome = yield* summarize();
    const state = yield* compactionStateEffect({ metadata, threadId });
    const { nodeText } = yield* memoryLookups(sources, [], state.blocks);
    const summaries = linedUp(messages, state.blocks, nodeText).filter(
      (block) => block.end <= userTurns(messages).length - recentRawUserTurns,
    );
    const manual: ManualCompaction = {
      clearedThrough: messages.length,
      summarizedTurns: summaries.at(-1)?.end ?? 0,
    };
    yield* compactionPromise({
      operation: "persist",
      reason: "MetadataFailed",
      evaluate: () => metadata.set(manualCompactionNamespace, threadId, manual),
    });
    const after = yield* compactEffect({
      messages,
      state: { ...state, manual },
      sources,
      budget,
    }).pipe(
      Effect.mapError((error) =>
        CompactionFailed.make({
          reason: error.reason,
          cause: error.cause,
          operation: "prepare-after",
        }),
      ),
    );
    return {
      cleared: Math.max(0, wholeToolOutputs(before.messages) - wholeToolOutputs(after.messages)),
      summarizedTurns: Math.max(0, after.summarizedTurns - before.summarizedTurns),
      summaryFailed: outcome !== "done",
      tokensBefore: estimateConversation(before.messages),
      tokensAfter: estimateConversation(after.messages),
    };
  });
export const compactByHand: {
  <E>(
    threadId: string,
    messages: readonly ModelMessage[],
    sources: CompactionSources,
    budget: Budget,
    summarize: () => Effect.Effect<SummaryOutcome, E>,
  ): (metadata: MetadataStore) => ReturnType<typeof compactByHandBody<E>>;
} & typeof compactByHandBody = EffectFunction.dual(6, compactByHandBody);
