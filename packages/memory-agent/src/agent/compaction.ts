import { Function as EffectFunction, pipe } from "effect";
import { isTruthy } from "../truthy.ts";
import type { ChatMiddleware, MetadataStore, ModelMessage } from "@tanstack/ai";
import {
  Array as EffectArray,
  HashMap,
  HashSet,
  MutableHashSet,
  Effect,
  Option,
  Ref,
  Schema,
} from "effect";
import {
  type ChatMetadata,
  type ChatMetadataFailed,
  tanstackMetadata,
} from "../chat-store/metadata.ts";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { RunStore } from "../loop/store.ts";
import type { ModelHandoffFailed } from "./model-handoff.ts";
import { recentRawUserTurns } from "./compaction-policy.ts";
import {
  consumeColdObservationEffect,
  type ContextUsageFailed,
  pendingColdObservationEffect,
} from "./context-usage.ts";
import type { CompactResult, CompactionStage } from "./run-state.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import type { NodeStoreFailed } from "../memory/nodes.ts";

/** A tool call as a message carries it. */
export interface ConversationToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/**
 * What compaction reads of a message. The app's stored messages have it, and so do TanStack's
 * until step 7 of docs/effect-ai-migration.md.
 */
export interface ConversationMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly id?: string | undefined;
  readonly content?:
    | string
    | null
    | ReadonlyArray<{ readonly type: string; readonly content?: string }>
    | undefined;
  readonly toolCalls?: ReadonlyArray<ConversationToolCall> | undefined;
  readonly toolCallId?: string | undefined;
}

/** A message compaction sends in place of others: a summary, a marker, a pointer or leads. */
export type CompactionMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly toolCalls?: Array<ConversationToolCall>;
    };

export const CompactionReason = Schema.TaggedUnion({
  MetadataFailed: {},
  RetrievalFailed: {},
  HistoryFailed: {},
  MemoryFailed: {},
});

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
  reason: CompactionReason,
  cause: Schema.Defect(),
}) {}

const compactionPromise = <A>(options: {
  readonly operation: CompactionFailed["operation"];
  readonly reason: keyof typeof CompactionReason.cases;
  readonly evaluate: () => PromiseLike<A>;
}) =>
  Effect.tryPromise({
    try: options.evaluate,
    catch: (cause) =>
      CompactionFailed.make({
        operation: options.operation,
        reason: CompactionReason.cases[options.reason].make({}),
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
export const messageText = (message: ConversationMessage) =>
  isText(message.content)
    ? message.content
    : (message.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.content ?? ""] : []))
        .join("");
const isText = Schema.is(Schema.String);

/**
 * Tokens of a message, roughly: English and code take about four characters a token, Korean and
 * other scripts about one. The default estimate (characters / 4) would let Korean text grow far
 * past the budget before anything is compacted.
 */
export function estimateTokens(message: ConversationMessage): number {
  const calls = isTruthy(message.toolCalls?.length) ? JSON.stringify(message.toolCalls) : "";
  let ascii = 0;
  let other = 0;
  for (const character of messageText(message) + calls) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export const estimateConversation = (messages: ReadonlyArray<ConversationMessage>) =>
  messages.reduce((sum, message) => sum + estimateTokens(message), 0);

const clearedPrefix = "[Tool output cleared to save context.";

/** What a cleared tool result says instead of its output. */
export function clearedOutput(nodeId: string | null) {
  return isTruthy(nodeId)
    ? `${clearedPrefix} It is kept in memory as node ${nodeId}: call read_evidence with that id to read it again.]`
    : `${clearedPrefix} It is kept in memory: find it with find_memory, then read it with read_evidence.]`;
}

/** Tool results the model is sent in full. */
const wholeToolOutputs = (messages: ReadonlyArray<ConversationMessage>) =>
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
function clearAnswered<M extends ConversationMessage>(
  messages: ReadonlyArray<M>,
  toolResultId: (toolCallId: string) => string | null,
  keepLatestAnswered: boolean,
): ReadonlyArray<M> | null {
  const answered = messages.findLastIndex(
    (message) => message.role === "assistant" && (message.toolCalls ?? []).length === 0,
  );
  // Without an answer, nothing before it is cleared.
  const end = keepLatestAnswered
    ? messages.slice(0, answered + 1).findLastIndex((message) => message.role === "user")
    : answered + 1;
  const next = messages.map((message, index) => {
    const content =
      message.role === "tool" && index < end && isTruthy(message.toolCallId)
        ? clearedOutput(toolResultId(message.toolCallId))
        : message.content;
    return content === message.content ? message : { ...message, content };
  });
  return changed(messages, next) ? next : null;
}

/** Whether a step of compaction replaced a message. */
const changed = (
  before: ReadonlyArray<ConversationMessage>,
  after: ReadonlyArray<ConversationMessage>,
) => after.length !== before.length || after.some((message, index) => message !== before[index]);

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
export const userTurns = (messages: ReadonlyArray<ConversationMessage>) =>
  messages.flatMap((message, index) => (message.role === "user" ? [index] : []));

/**
 * Whether a user message is the turn a node recorded. Memory keeps a turn without a pasted key,
 * so a node with a hidden secret matches whatever the message says.
 */
const sameTurnBody = (message: ConversationMessage | undefined, recorded: string | null) =>
  message?.role === "user" &&
  recorded !== null &&
  (messageText(message) === recorded || recorded.includes("[redacted:"));
export const sameTurn: {
  (
    recorded: string | null,
  ): (message: ConversationMessage | undefined) => ReturnType<typeof sameTurnBody>;
} & typeof sameTurnBody = EffectFunction.dual(2, sameTurnBody);

/** The summaries that fit this conversation, oldest first, up to the first that does not. */
export const linedUp: {
  (
    blocks: readonly SummaryBlock[],
    nodeText: (id: string) => string | null,
  ): (messages: ReadonlyArray<ConversationMessage>) => ReturnType<typeof linedUpBody>;
} & typeof linedUpBody = EffectFunction.dual(3, linedUpBody);
function linedUpBody(
  messages: ReadonlyArray<ConversationMessage>,
  blocks: readonly SummaryBlock[],
  nodeText: (id: string) => string | null,
): SummaryBlock[] {
  const turns = userTurns(messages);
  // Every block before one that fits fitted too, so the one before it is the previous fitting one.
  return EffectArray.takeWhile(blocks, (block, index) => {
    const next = turns[block.end];
    return (
      block.end > (blocks[index - 1]?.end ?? 0) &&
      next !== undefined &&
      sameTurn(messages[next], nodeText(block.nextTurnNodeId))
    );
  });
}

/**
 * Immutable summaries, one message per stored block. Appending a block never rewrites an earlier
 * message, so the provider can keep the KV prefix through the previous block.
 */
const summaryMessages = (blocks: readonly SummaryBlock[]): ReadonlyArray<CompactionMessage> =>
  blocks.map((block, index) => ({
    role: "assistant",
    content: `[Summary of user turns ${(blocks[index - 1]?.end ?? 0) + 1}-${block.end}, written afterwards. The turns themselves were left out to save context and are kept in memory. This summary is a lead, not evidence: read the nodes it cites with read_evidence before relying on a point. Only the user's own words are decisions.]\n\n${block.text}`,
  }));

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
  return Effect.runPromise(
    compactionStateEffect({ metadata: tanstackMetadata(metadata), threadId }),
  );
}

const metadataFailed =
  (operation: CompactionFailed["operation"]) =>
  ({ cause }: ChatMetadataFailed | ContextUsageFailed) =>
    CompactionFailed.make({
      operation,
      reason: CompactionReason.cases.MetadataFailed.make({}),
      cause,
    });

export const compactionStateEffect = Effect.fnUntraced(function* (options: {
  readonly metadata: ChatMetadata;
  readonly threadId: string;
}) {
  const { metadata, threadId } = options;
  const [manual, summaries] = yield* Effect.all(
    [
      metadata.get(manualCompactionNamespace, threadId),
      metadata.get(turnSummariesNamespace, threadId),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(metadataFailed("read-state")));
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
   * Bounded, variable-tail leads for content this request left out. It fails closed: when
   * retrieval is unavailable it gives none, and compaction still sends the request.
   */
  readonly retrievalAppendix?: (
    sent: ReadonlyArray<ConversationMessage>,
  ) => Effect.Effect<CompactionMessage | null>;
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
export const answeredToolCalls = (messages: ReadonlyArray<ConversationMessage>) =>
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
  messages: ReadonlyArray<ConversationMessage>,
  blocks: readonly SummaryBlock[],
) {
  const [results, texts] = yield* Effect.all([
    sources.toolResultIds(answeredToolCalls(messages)),
    sources.nodeTexts(EffectArray.dedupe(blocks.map((block) => block.nextTurnNodeId))),
  ]).pipe(
    Effect.mapError((cause) =>
      CompactionFailed.make({
        operation: "read-memory",
        reason: CompactionReason.cases.MemoryFailed.make({}),
        cause,
      }),
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

const decodeToolArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Partial historical calls cannot be replayed; keep the stored transcript intact. */
export function replayableToolHistory<M extends ConversationMessage>(
  messages: ReadonlyArray<M>,
): ReadonlyArray<M> {
  const replayable = messages.map((message) => {
    const toolCalls = (message.toolCalls ?? []).filter((call) =>
      Option.isSome(decodeToolArguments(call.function.arguments)),
    );
    return toolCalls.length === (message.toolCalls ?? []).length
      ? message
      : { ...message, toolCalls };
  });
  // A result cannot be sent without its replayable matching call.
  const callIds = HashSet.fromIterable(
    replayable.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
  );
  return replayable.filter(
    (message) =>
      message.role !== "tool" ||
      message.toolCallId === undefined ||
      HashSet.has(callIds, message.toolCallId),
  );
}

/** What a request sends so far, and the strongest operation that made it so. */
interface Sending<M> {
  readonly sent: ReadonlyArray<M | CompactionMessage>;
  readonly stage: CompactionStage;
}

export interface Compacted<M> {
  readonly messages: ReadonlyArray<M | CompactionMessage>;
  /** The strongest operation applied while preparing this request. */
  readonly stage: CompactionStage;
  /** The user turns sent as their summaries. */
  readonly summarizedTurns: number;
}

/**
 * Stored, validated blocks are monotonic: even a small request keeps earlier turns summarized.
 * `firstKept` is where the first turn after them starts.
 */
const summarized =
  (summaries: ReadonlyArray<SummaryBlock>, firstKept: number | undefined) =>
  <M>(sending: Sending<M>): Sending<M> =>
    summaries.length > 0 && firstKept !== undefined
      ? {
          sent: [...summaryMessages(summaries), ...sending.sent.slice(firstKept)],
          stage: "summarize",
        }
      : sending;

/**
 * Without a ready summary, a one-shot cold hint can still make the next request smaller: the
 * messages before `firstKept` give way to a pointer back to the saved conversation.
 */
const leftOutEarly =
  (firstKept: number | undefined) =>
  <M>(sending: Sending<M>): Sending<M> =>
    firstKept !== undefined && firstKept > 0
      ? {
          sent: [
            { role: "assistant", content: droppedMarker(firstKept) },
            ...sending.sent.slice(firstKept),
          ],
          stage: "leave-out",
        }
      : sending;

/**
 * Results that cannot be replayed are dropped anyway; measured with them, a request whose history
 * holds large unreplayable output would leave out messages it has room for.
 */
const paired = <M extends ConversationMessage>(sending: Sending<M>): Sending<M> => {
  const sent = replayableToolHistory(sending.sent);
  return changed(sending.sent, sent)
    ? { sent, stage: sending.stage === "none" ? "clear-answered" : sending.stage }
    : sending;
};

const isToolResult = (message: ConversationMessage) => message.role === "tool";

/**
 * Where the latest messages that fit in `keep` tokens begin, at least the last one, moved past a
 * leading tool result so what is kept never starts with a result whose call was left out. As
 * `evictOldest` of @tanstack/ai-compaction found it.
 */
const keptFrom = (messages: ReadonlyArray<ConversationMessage>, keep: number) => {
  const fitting = EffectArray.takeWhile(
    EffectArray.scan(
      EffectArray.reverse(messages),
      0,
      (kept, message) => kept + estimateTokens(message),
    ).slice(1),
    (kept) => kept <= keep,
  ).length;
  const start = Math.min(messages.length - fitting, messages.length - 1);
  const afterResults = start + EffectArray.takeWhile(messages.slice(start), isToolResult).length;
  // Only results follow: keep from the call before them.
  return afterResults < messages.length
    ? afterResults
    : Math.max(
        0,
        messages.length -
          EffectArray.takeWhile(EffectArray.reverse(messages), isToolResult).length -
          1,
      );
};

/** Past `leaveOutAt`, the oldest messages give way to a marker and the latest half is kept. */
const leftOutPast =
  (leaveOutAt: number) =>
  <M extends ConversationMessage>(sending: Sending<M>): Sending<M> => {
    const cut =
      estimateConversation(sending.sent) > leaveOutAt
        ? keptFrom(sending.sent, Math.floor(leaveOutAt / 2))
        : 0;
    return cut > 0
      ? {
          sent: [{ role: "user", content: droppedMarker(cut) }, ...sending.sent.slice(cut)],
          stage: "leave-out",
        }
      : sending;
  };

/**
 * Do not perturb an intact prefix with retrieval. Once this request did omit original content, an
 * optional appendix belongs at its variable tail, immediately before the latest user message, so
 * providers that require user-last requests still accept it.
 */
const withAppendix = <M extends ConversationMessage>(
  sources: CompactionSources,
  sending: Sending<M>,
): Effect.Effect<Sending<M>> =>
  Option.match(
    Option.filter(Option.fromNullishOr(sources.retrievalAppendix), () => sending.stage !== "none"),
    {
      onNone: () => Effect.succeed(sending),
      onSome: (retrieve) =>
        Effect.map(retrieve(sending.sent), (appendix) => {
          const lastUser = sending.sent.findLastIndex((message) => message.role === "user");
          return appendix === null
            ? sending
            : {
                ...sending,
                sent:
                  lastUser < 0
                    ? [...sending.sent, appendix]
                    : [
                        ...sending.sent.slice(0, lastUser),
                        appendix,
                        ...sending.sent.slice(lastUser),
                      ],
              };
        }),
    },
  );

/**
 * The conversation as the model is sent it. Answered tool outputs become pointers after a run,
 * and validated older summary blocks replace raw turns regardless of conversation size. Past
 * `leaveOutAt` the oldest messages are left out. The saved conversation is never changed.
 */
export const compactEffect = Effect.fnUntraced(function* <M extends ConversationMessage>(options: {
  readonly messages: ReadonlyArray<M>;
  readonly state: CompactionState;
  readonly sources: CompactionSources;
  readonly budget: Budget;
  readonly early?: boolean;
}): Effect.fn.Return<Compacted<M>, CompactionFailed> {
  const { messages, state, sources, budget, early = false } = options;
  // A record for a longer conversation was made for another one.
  const manual = state.manual.clearedThrough <= messages.length ? state.manual : noManualCompaction;
  const { toolResultId, nodeText } = yield* memoryLookups(sources, messages, state.blocks);
  const turns = userTurns(messages);
  const summaries = linedUp(messages, state.blocks, nodeText);
  const summarizedTurns = summaries.at(-1)?.end ?? 0;

  const clearedByHand = clearAnswered(
    messages.slice(0, manual.clearedThrough),
    toolResultId,
    false,
  );
  const byHand =
    clearedByHand === null
      ? messages
      : [...clearedByHand, ...messages.slice(manual.clearedThrough)];
  // An answered run's tool payload is cleared once the run after it has answered too. This
  // transition happens once; clearAnswered leaves pointers unchanged and never touches the run
  // still in progress.
  const cleared = clearAnswered(byHand, toolResultId, true);
  const answeredCleared: Sending<M> = {
    sent: cleared ?? byHand,
    stage: clearedByHand !== null || cleared !== null ? "clear-answered" : "none",
  };
  const prepared = pipe(
    answeredCleared,
    summarized(summaries, turns[summarizedTurns]),
    // The latest two complete user turns stay intact.
    leftOutEarly(
      early && summarizedTurns === 0 && turns.length > recentRawUserTurns
        ? turns[turns.length - recentRawUserTurns]
        : undefined,
    ),
    paired,
    leftOutPast(budget.leaveOutAt),
  );
  // Leaving out the oldest messages can split a call from its result.
  const { sent, stage } = paired(yield* withAppendix(sources, prepared));
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
    error: Schema.NullOr(Schema.String),
  }),
);

const preview = (text: string, length = 800) =>
  text.length <= length
    ? text
    : `${text.slice(0, Math.ceil(length / 2))}… (${text.length - length} omitted characters; full result available by ID) …${text.slice(-Math.floor(length / 2))}`;

const shellPreview = (content: string) =>
  Option.map(Schema.decodeOption(largeShellResult)(content), (result) => ({
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
  }));

const reportPreview = (content: string) =>
  Option.map(Schema.decodeOption(largeReportResult)(content), (result) => ({
    ...result,
    answer: preview(result.answer, 1_200),
    error: result.error === null ? null : preview(result.error, 1_500),
  }));

/** The tools whose large results are sent as previews. */
const PreviewedTool = Schema.Literals([
  "run_skill",
  "run_shell",
  "list_files",
  "search_files",
  "get_subagent_reports",
  "get_subagent_report",
]);

/** How each previewed tool's result is shortened, or none when it does not have its shape. */
const previews: Record<typeof PreviewedTool.Type, (content: string) => Option.Option<object>> = {
  run_skill: shellPreview,
  // run_shell and get_subagent_report are in history recorded before their replacements.
  run_shell: shellPreview,
  list_files: (content) =>
    Option.map(Schema.decodeOption(largeListResult)(content), (result) => ({
      ...result,
      paths: result.paths.slice(0, 20),
      shown: Math.min(20, result.paths.length),
    })),
  search_files: (content) =>
    Option.map(Schema.decodeOption(largeSearchResult)(content), (result) => ({
      ...result,
      matches: result.matches.slice(0, 8).map((match) => ({
        ...match,
        text: preview(match.text, 180),
      })),
      shown: Math.min(8, result.matches.length),
      skipped: result.skipped.slice(0, 5),
    })),
  get_subagent_reports: reportPreview,
  get_subagent_report: reportPreview,
};

/** Purpose-specific provider previews for recorded results; original history stays unchanged. */
export const lightweightToolResults: {
  (
    toolResultId: (toolCallId: string) => string | null,
  ): <M extends ConversationMessage>(
    messages: ReadonlyArray<M>,
  ) => ReturnType<typeof lightweightToolResultsBody<M>>;
} & typeof lightweightToolResultsBody = EffectFunction.dual(2, lightweightToolResultsBody);
function lightweightToolResultsBody<M extends ConversationMessage>(
  messages: ReadonlyArray<M>,
  toolResultId: (toolCallId: string) => string | null,
): ReadonlyArray<M> {
  const names = HashMap.fromIterable(
    messages.flatMap((message) =>
      (message.toolCalls ?? []).map((call) => [call.id, call.function.name] as const),
    ),
  );
  const shortened = (message: M) =>
    Option.gen(function* () {
      const toolCallId = yield* Option.fromNullishOr(
        message.role === "tool" ? message.toolCallId : undefined,
      );
      const content = yield* Option.liftPredicate(message.content, isText);
      const name = yield* Option.filter(HashMap.get(names, toolCallId), Schema.is(PreviewedTool));
      const serialized = JSON.stringify(yield* previews[name](content));
      // Never promise an ID that has not been recorded.
      const nodeId = yield* Option.liftPredicate(toolResultId(toolCallId), isTruthy);
      const text = `[${name} preview; full result: read_tool_result ID ${nodeId}, page by offset. Check omitted entries before relying on them.]\n${serialized}`;
      return yield* Option.liftPredicate(
        text,
        () => serialized.length < content.length && text.length < content.length,
      );
    });
  return messages.map((message) =>
    Option.match(shortened(message), {
      onNone: () => message,
      onSome: (content) => ({ ...message, content }),
    }),
  );
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
          const restored =
            historyForModel === undefined
              ? null
              : yield* compactionPromise({
                  operation: "history",
                  reason: "HistoryFailed",
                  evaluate: () => historyForModel(config.messages),
                });
          const { messages, stage } = yield* requestHistory({
            metadata: tanstackMetadata(metadata),
            threadId: ctx.threadId,
            messages: config.messages,
            restored,
            sources,
            budget,
          });
          observed(stage);
          return changed(config.messages, messages)
            ? { providerMessages: [...messages] }
            : undefined;
        }),
        { signal: ctx.signal },
      ),
  };
}

/**
 * What one model request of a session sends of its conversation, and the stage that made it so
 * (see {@link compactEffect}). `restored` is the history a model handoff put in place of
 * `messages`, headed by its notice. A pending cold-cache observation leaves out early once and is
 * used up.
 */
export const requestHistory = Effect.fnUntraced(function* <M extends ConversationMessage>(options: {
  readonly metadata: ChatMetadata;
  readonly threadId: string;
  readonly messages: ReadonlyArray<M>;
  readonly restored: ReadonlyArray<M | CompactionMessage> | null;
  readonly sources: CompactionSources;
  readonly budget: Budget;
}): Effect.fn.Return<
  { readonly messages: ReadonlyArray<M | CompactionMessage>; readonly stage: CompactionStage },
  CompactionFailed
> {
  const { metadata, threadId, messages, restored, sources, budget } = options;
  const state = yield* compactionStateEffect({ metadata, threadId });
  const coldId = yield* pendingColdObservationEffect({ metadata, threadId }).pipe(
    Effect.mapError(metadataFailed("read-cold")),
  );
  const removedTurns =
    restored === null ? 0 : userTurns(messages).length - userTurns(restored).length;
  const restoredContext = restored?.[0];
  const compacted = yield* compactEffect({
    messages: restored === null ? messages : restored.slice(1),
    state:
      restored === null
        ? state
        : {
            manual: noManualCompaction,
            blocks: state.blocks
              .filter((block) => block.end > removedTurns)
              .map((block) => ({ ...block, end: block.end - removedTurns })),
          },
    sources,
    budget:
      restoredContext === undefined
        ? budget
        : {
            ...budget,
            leaveOutAt: Math.max(1, budget.leaveOutAt - estimateTokens(restoredContext)),
          },
    early: coldId !== null,
  });
  if (coldId !== null)
    yield* consumeColdObservationEffect({ metadata, threadId, observationId: coldId }).pipe(
      Effect.mapError(metadataFailed("consume-cold")),
    );
  const question = restored?.findLast(
    (message) => message.role === "user" && messageText(message).trim(),
  );
  const retained =
    question !== undefined && !compacted.messages.includes(question)
      ? [question, ...compacted.messages]
      : compacted.messages;
  const outgoing =
    restoredContext === undefined ? compacted.messages : [restoredContext, ...retained];
  const { toolResultId } = yield* memoryLookups(sources, outgoing, []);
  return {
    messages: lightweightToolResults(outgoing, toolResultId).filter(
      (message) => !isEmptyUserText(message),
    ),
    stage: restored !== null && compacted.stage === "none" ? "summarize" : compacted.stage,
  };
});

/**
 * Compaction in the Effect AI loop: what each model step sends of its conversation. Goes last
 * among the hooks that shape the request, before local images are inlined. `stage` is the stage
 * the latest request reached, for its usage record.
 */
export const compactionHook = Effect.fnUntraced(function* (options: {
  readonly sources: CompactionSources;
  readonly budget: Budget;
  /** The history a model handoff puts in place of the conversation, or null to keep it. */
  readonly restore: (
    messages: ReadonlyArray<StoredMessage>,
  ) => Effect.Effect<ReadonlyArray<StoredMessage> | null, ModelHandoffFailed>;
}) {
  const stage = yield* Ref.make<CompactionStage>("none");
  const hook: RunHook<RunStore> = {
    request: ({ threadId }, request) =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const restored = yield* options.restore(request.history).pipe(
          Effect.mapError((cause) =>
            CompactionFailed.make({
              operation: "history",
              reason: CompactionReason.cases.HistoryFailed.make({}),
              cause,
            }),
          ),
        );
        const sent = yield* requestHistory({
          metadata: store.chatMetadata,
          threadId,
          messages: request.history,
          restored,
          sources: options.sources,
          budget: options.budget,
        });
        yield* Ref.set(stage, sent.stage);
        return { ...request, history: sent.messages };
      }).pipe(Effect.mapError(asRunFailed)),
  };
  return { hook, stage: Ref.get(stage) };
});

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
  metadata: ChatMetadata,
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
    yield* metadata
      .set(manualCompactionNamespace, threadId, manual)
      .pipe(Effect.mapError(metadataFailed("persist")));
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
  ): (metadata: ChatMetadata) => ReturnType<typeof compactByHandBody<E>>;
} & typeof compactByHandBody = EffectFunction.dual(6, compactByHandBody);
