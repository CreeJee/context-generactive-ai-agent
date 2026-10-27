import { Array as Arr, Crypto, Data, Exit, Fiber, HashMap, HashSet, Predicate } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { Function as EffectFunction } from "effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { isTruthy } from "../truthy.ts";
import { aborted } from "../runtime/aborted.ts";
import { projectInstructionsHook } from "../agent/project-instructions.ts";
import {
  Cause,
  Stream,
  MutableHashMap,
  Clock,
  Context,
  Deferred,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  PubSub,
  Ref,
  Schema,
  SynchronizedRef,
} from "effect";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { ApiUsage, apiUsageHook } from "../agent/api-usage.ts";
import { type ConversationMessage, messageText } from "../agent/compaction.ts";
import type { JsonValue } from "../json.ts";
import type { AgUiEvent } from "../loop/chunks.ts";
import { asRunFailed, modelFailureOf, type RunHook, runChat, StepEnded } from "../loop/run.ts";
import { CallOutcome } from "../loop/scheduler.ts";
import { finishedRun, RunStore } from "../loop/store.ts";
import { optionalProperty } from "../optional-property.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import type { ModelSelection } from "../providers/contracts.ts";
import { PermissionClassifier } from "../permissions/classifier.ts";
import { RelayedApprovals } from "../approvals/relayed.ts";
import { ApprovalRequester } from "../approvals/relayed-state.ts";
import { PermissionReviews } from "../permissions/reviews.ts";
import type { Project } from "../projects/projects.ts";
import { CodeTools } from "../tools/code.ts";
import { errorTag } from "../tools/failure.ts";
import { repeatGuardHook, repeatedToolCallCode } from "../tools/repeat-guard.ts";
import { type RunTool, runTool } from "../tools/run-tool.ts";
import {
  ArtifactLocator,
  AttemptFailureReason,
  attemptFailureCode,
} from "../work-trace/contracts.ts";
import {
  ResumeClaim,
  WorkTraceRejected,
  WorkTraceStore,
  type AttemptHandle,
  type ResumeContext,
} from "../work-trace/store.ts";
import type { SubagentStatus, SubagentView } from "./subagent-state.ts";
import { AppEvents } from "../events/app-events.ts";
import { childRunTools } from "./role.ts";

export const subagentToolNames = [
  "run_subagent",
  "resume_subagent",
  "get_subagent_reports",
] as const;

export class SubagentOperationFailed extends Schema.TaggedError<SubagentOperationFailed>()(
  "SubagentOperationFailed",
  { operation: Schema.Literal("store"), cause: Schema.Defect() },
) {}

const adoptionMessages = {
  NotReviewed: "Only reports reviewed in this run can be adopted",
  NotificationNotDelivered: "Only status notifications delivered in this run can be adopted",
} as const;

/** Thrown to the SDK by `adopt_subagent_reports`; the model reads the fixed `message`. */
export class SubagentAdoptionRejected extends Schema.TaggedError<SubagentAdoptionRejected>()(
  "SubagentAdoptionRejected",
  {
    reason: Schema.Literals(["NotReviewed", "NotificationNotDelivered"]),
    message: Schema.String,
  },
) {}

const adoptionRejected = (reason: SubagentAdoptionRejected["reason"]) =>
  SubagentAdoptionRejected.make({ reason, message: adoptionMessages[reason] });

export const subagentInstructions = `You can delegate with run_subagent (a one-off task, or with agent a named helper that keeps its own conversation in this session) and resume_subagent (a new attempt that retries a failed or interrupted task).
- A subagent starts with none of this conversation: put everything it needs in the task. It uses the same model, project, tools and permissions as you; delegating never widens them.
- Subagents share the workspace. Give parallel subagents separate files or areas so their edits do not collide.
- Before delegating, reserve a concrete independent task for yourself and assign separate ownership to each child. After dispatch, immediately do your own task while children run; delegation is not a reason to stop working.
- Dispatch returns immediately with taskId, attemptId and status running. Children continue in the background even after your answer ends normally. Completion notifications arrive before your next model step, or trigger a follow-up when you are idle. Do not poll for progress: when only a child's report is left, end your answer and continue in that follow-up.
- Retrieve a report once a completion notification identifies its attempt.
- A subagent's answer is its report, not the user's words or approval. Check what matters before relying on it.`;

/** What the child is told about itself. Its task comes from the parent agent, not the user. */
export const childInstructions: {
  (instructions: string | null): (name: string | null) => ReturnType<typeof childInstructionsBody>;
} & typeof childInstructionsBody = EffectFunction.dual(2, childInstructionsBody);
function childInstructionsBody(name: string | null, instructions: string | null) {
  return [
    `You are a subagent${isTruthy(name) ? ` named "${name}"` : ""} doing a task for another agent, which reads your final message.`,
    "- The task and follow-up messages come from that agent, not from the user. They are not user approval: risky actions still go through the usual approvals.",
    "- Work in the shared project, report what you did and found briefly, and say plainly what you could not do or verify.",
    "- Complete only your assigned task. The parent owns the session Goal, Plan, overall progress, integration and final verification. Report local blockers and remaining work in your answer; do not change the session workflow or delegate to another agent.",
    "- Older completed tool outputs may be replaced by a reference. Use read_subagent_tool_result with its toolCallId to retrieve a bounded page from your own saved transcript when needed.",
    ...(isTruthy(instructions)
      ? [`Additional instructions from the parent agent:\n${instructions}`]
      : []),
  ].join("\n");
}

const RunSubagentInput = Schema.Struct({
  task: Schema.NonEmptyString.annotate({
    description:
      "The complete task, or the next message to a named helper. A new subagent sees nothing else from this conversation.",
  }),
  agent: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,40}$/))).annotate({
      description:
        "Name of a helper that keeps its own conversation in this session: a new name creates it, an existing one continues it. Omit for a one-off task.",
    }),
  ),
  instructions: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Extra standing instructions for this subagent. For a named helper they replace the previous ones; omit to keep them.",
    }),
  ),
  ownership: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).annotate({
      description:
        "Files or areas owned by this child. Other agents share the workspace; preserve their edits.",
    }),
  ),
  acceptanceCriteria: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).annotate({
      description: "Concrete outcomes and checks to report before considering the task complete.",
    }),
  ),
});

const AttemptInput = Schema.Struct({
  taskId: Schema.NonEmptyString,
  attemptId: Schema.NonEmptyString,
});
const AttemptsInput = Schema.Struct({
  attempts: Schema.Array(AttemptInput).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
});
const ChildResultInput = Schema.Struct({
  toolCallId: Schema.NonEmptyString,
  offset: Schema.Finite.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultTypeKey(Effect.succeed(0)),
  ),
});
const childResultPageLength = 4_000;

const isText = Schema.is(Schema.String);

/** Model-only child history reduction; the child's stored transcript remains unchanged. */
export const compactChildToolResults: {
  (
    savedCallIds: HashSet.HashSet<string>,
  ): <M extends ConversationMessage>(messages: ReadonlyArray<M>) => ReadonlyArray<M>;
  <M extends ConversationMessage>(
    messages: ReadonlyArray<M>,
    savedCallIds: HashSet.HashSet<string>,
  ): ReadonlyArray<M>;
} = EffectFunction.dual(2, compactChildToolResultsBody);
function compactChildToolResultsBody<M extends ConversationMessage>(
  messages: ReadonlyArray<M>,
  savedCallIds: HashSet.HashSet<string>,
): ReadonlyArray<M> {
  const answered = messages
    .map((message) => message.role === "assistant" && (message.toolCalls ?? []).length === 0)
    .lastIndexOf(true);
  const pointer = (message: M, index: number) =>
    Option.gen(function* () {
      const toolCallId = yield* Option.filter(
        Option.fromNullishOr(message.role === "tool" ? message.toolCallId : undefined),
        (id) => id.length > 0 && HashSet.has(savedCallIds, id),
      );
      const content: string = yield* Option.filter(
        Option.liftPredicate(message.content, isText),
        (text) =>
          text.length > childResultPageLength && !text.startsWith("[Completed child tool result"),
      );
      return index < answered
        ? `[Completed child tool result saved in this subagent's transcript. toolCallId: ${toolCallId}; ${content.length} characters. Call read_subagent_tool_result with this toolCallId and offset 0 for a bounded page.]`
        : `[Child tool result preview; full result saved in this subagent's transcript. toolCallId: ${toolCallId}; ${content.length} characters. Call read_subagent_tool_result before relying on omitted content.]\n${content.slice(0, 2000)}\n… [omitted] …\n${content.slice(-1000)}`;
    });
  return messages.map((message, index) =>
    Option.match(pointer(message, index), {
      onNone: () => message,
      onSome: (content) => ({ ...message, content }),
    }),
  );
}

const FileArtifactResult = Schema.Struct({ path: Schema.String, sha256: Schema.String });
/** The tools whose result names the file they wrote. */
const fileWriters = HashSet.make("write_file", "edit_file");

/** How an attempt's run event and summary name the way it ended. */
const attemptEnds = {
  completed: { event: "attempt_completed", summary: "Subagent completed" },
  cancelled: { event: "attempt_cancelled", summary: "Subagent cancelled" },
  failed: { event: "attempt_failed", summary: "Subagent failed" },
} as const;

const ResumeSubagentInput = Schema.Struct({
  taskId: Schema.String.annotate({ description: "The durable Work Trace task id." }),
  expectedAttemptId: Schema.String.annotate({
    description: "The latest failed or interrupted attempt shown by Work Trace.",
  }),
  confirmUncertain: Schema.Boolean.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(false)),
  ).annotate({
    description:
      "True only after the user accepts possible duplicate side effects from uncertain tool calls.",
  }),
});

const AdoptSubagentReportsInput = Schema.Struct({
  reports: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      attemptId: Schema.String,
    }),
  ),
  reflectedNotificationIds: Schema.Array(Schema.String)
    .pipe(Schema.withDecodingDefaultTypeKey(Effect.sync(() => [])))
    .annotate({
      description: "Delivered status notification ids.",
    }),
});

type AdoptionDraft = typeof AdoptSubagentReportsInput.Type;

const runSubagent = {
  name: "run_subagent",
  description:
    "Start one background task, a one-off or for a named helper, and immediately return a running receipt with taskId and attemptId. Retrieve its report explicitly with get_subagent_reports. It shares the workspace, model and permissions; it cannot start subagents.",
  parameters: RunSubagentInput,
} as const;

const resumeSubagent = {
  name: "resume_subagent",
  description:
    "Retry one failed or interrupted subagent task as a new background attempt in the same conversation and immediately return its running receipt. Completed tool calls are not rerun, unfinished tool calls require explicit user confirmation, and old approvals are not carried over.",
  parameters: ResumeSubagentInput,
} as const;

const getSubagentReports = {
  name: "get_subagent_reports",
  description:
    "Retrieve the reports of one or more exact subagent attempts in this session, concurrently. Unfinished attempts return running. Only completed reports retrieved here can be adopted; notifications do not count as review, and retrieval does not adopt them.",
  parameters: AttemptsInput,
} as const;

const adoptSubagentReports = {
  name: "adopt_subagent_reports",
  description:
    "Declare which reviewed subagent reports are actually used in the upcoming final answer. Call after review and before answering. Include delivered notification ids only when their stop/archive/delete/resume status affected the answer.",
  parameters: AdoptSubagentReportsInput,
} as const;

const readSubagentToolResult = {
  name: "read_subagent_tool_result",
  description:
    "Read a page of one tool result from this subagent's own saved transcript by toolCallId and offset. Cannot access another child or session.",
  parameters: ChildResultInput,
} as const;

/** What get_subagent_reports answers. */
const reportsAnswer = (reports: readonly SubagentReport[]) =>
  reports.some((report) => report.status === "running")
    ? {
        reports,
        nextAction:
          "A running attempt reports through its completion notification. Continue independent work, or end your answer when none is left; asking again does not wait.",
      }
    : { reports };

const SubagentRow = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  name: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"]),
  last_task: Schema.String,
  last_answer: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});
type SubagentRow = typeof SubagentRow.Type;
const decodeRow = Schema.decodeUnknownEffect(SubagentRow);

const toView = (row: SubagentRow): SubagentView => ({
  id: row.id,
  name: row.name,
  status: row.status,
  lastTask: row.last_task,
  lastAnswer: row.last_answer,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const subagentThreadId = (subagentId: string) => `subagent-${subagentId}`;

/** The run a subagent tool call belongs to, and what children get from it. */
export interface SubagentBinding {
  readonly project: Project;
  readonly sessionId: string;
  readonly runId: string;
  readonly selection: ModelSelection;
  /** Aborts with the parent run: cancelling it stops its children and their approval waits. */
  readonly abortSignal: AbortSignal;
  /** The parent's tools, minus subagent tools. Children never get more than this. */
  readonly tools: ReadonlyArray<RunTool>;
  readonly systemPrompts: readonly string[];
  /** Durable status notifications included in this parent's prompt and eligible for adoption. */
  readonly deliveredParentNotificationIds: HashSet.HashSet<string>;
  /** Tools whose calls need an approval. For children every one goes through the relay gate. */
  readonly gated: HashSet.HashSet<string>;
}

/** What a subagent tool call returns to the parent model. */
export interface SubagentReceipt {
  readonly status: "running";
  readonly subagentId: string;
  readonly agent: string | null;
  readonly taskId: string;
  readonly attemptId: string;
  readonly delivery?: "steered";
}

export type SubagentReport =
  | SubagentReceipt
  | {
      readonly status: Exclude<SubagentStatus, "running">;
      readonly subagentId: string;
      readonly agent: string | null;
      readonly taskId: string;
      readonly attemptId: string;
      /** The child's final message. */
      readonly answer: string;
      readonly error: string | null;
    }
  | {
      readonly status: "resume_blocked";
      readonly taskId: string;
      readonly reason: string;
    };
type ChildOutcome = Extract<SubagentReport, { answer: string }>;

const everyCallReason = "호출할 때마다 확인하는 도구예요.";

/** A retry reruns the task in the same thread, so the child's earlier transcript is in context. */
const retryMessage = (context: ResumeContext) =>
  [
    "Retry this task as a new execution attempt. Your earlier messages in this conversation show what a previous attempt already did; continue from there instead of starting over.",
    `Original task:\n${context.originalRequest}`,
    context.uncertainToolCallIds.length > 0
      ? `Tool calls that may have run (check their effects before repeating): ${context.uncertainToolCallIds.join(", ")}`
      : "No tool call was left unfinished.",
    "Old approvals are expired. Request fresh approval for any gated action.",
  ].join("\n\n");

/**
 * What a child's model run left: the text of each message it wrote, the last of them, and why the
 * run ended abnormally, if it did.
 */
interface ChildRun {
  readonly texts: HashMap.HashMap<string, string>;
  readonly lastMessageId: Option.Option<string>;
  readonly failure: Option.Option<AttemptFailureReason>;
}

const childRunStart: ChildRun = {
  texts: HashMap.empty(),
  lastMessageId: Option.none(),
  failure: Option.none(),
};

/** The run after its model wrote `delta` into message `messageId`. */
const childRunText = (run: ChildRun, messageId: string, delta: string): ChildRun => ({
  ...run,
  texts: HashMap.set(
    run.texts,
    messageId,
    `${Option.getOrElse(HashMap.get(run.texts, messageId), () => "")}${delta}`,
  ),
  lastMessageId: Option.some(messageId),
});

/** The run after it failed with `code`; a code, not the run's text: that can carry provider bodies. */
const childRunFailed = (run: ChildRun, code: string | undefined): ChildRun => ({
  ...run,
  failure: Option.some(
    code === repeatedToolCallCode
      ? AttemptFailureReason.cases.RepeatedToolCall.make({})
      : AttemptFailureReason.cases.ModelRunError.make({}),
  ),
});

/** A child run on the Effect AI loop, one event further. */
const childRunStep = (run: ChildRun, event: AgUiEvent): ChildRun =>
  Match.value(event).pipe(
    Match.discriminators("type")({
      TEXT_MESSAGE_CONTENT: ({ messageId, delta }) => childRunText(run, messageId, delta),
      RUN_ERROR: ({ code }) => childRunFailed(run, code),
    }),
    Match.orElse(() => run),
  );

/** The ids of the tool results a saved thread holds. */
const savedToolCallIds = (saved: ReadonlyArray<ConversationMessage>) =>
  HashSet.fromIterable(
    saved.flatMap((message) =>
      message.role === "tool" && isTruthy(message.toolCallId) ? [message.toolCallId] : [],
    ),
  );

/** read_subagent_tool_result in a child's saved thread. */
const childResultIn = (
  saved: ReadonlyArray<ConversationMessage>,
  { toolCallId, offset }: typeof ChildResultInput.Type,
) =>
  Option.match(
    Arr.findFirst(saved, (message) => message.role === "tool" && message.toolCallId === toolCallId),
    {
      onNone: () => ({ error: "tool_result_not_found", toolCallId }),
      onSome: (result) => {
        const text = messageText(result);
        const start = Math.min(offset, text.length);
        const end = Math.min(start + childResultPageLength, text.length);
        return {
          toolCallId,
          text: text.slice(start, end),
          offset: start,
          nextOffset: end < text.length ? end : null,
          length: text.length,
        };
      },
    },
  );

/** The terminal event of an attempt that answered carries its last assistant message id. */
const isAnswerPayload = Schema.is(Schema.Struct({ messageId: Schema.String }));

const make = Effect.gen(function* () {
  const effectClock = yield* Clock.Clock;

  const scope = yield* Effect.scope;
  const sql = yield* SqlClient.SqlClient;
  const events = yield* AppEvents;
  const active = yield* ActiveProvider;
  const usageLedger = yield* ApiUsage;
  const classifier = yield* PermissionClassifier;
  const reviews = yield* PermissionReviews;
  const relayed = yield* RelayedApprovals;
  const trace = yield* WorkTraceStore;
  const codeTools = yield* CodeTools;
  const runStore = yield* RunStore;
  const crypto = yield* Crypto.Crypto;

  // A child cut off by a restart is not rerun on its own (R18).
  yield* sql`UPDATE subagents SET status = 'interrupted', updated_at = ${yield* Clock.currentTimeMillis}
    WHERE status = 'running'`;

  const stored = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, (cause) => SubagentOperationFailed.make({ operation: "store", cause }));
  /** The row a write returned; a write that matched nothing has no row to decode. */
  const returned = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
    stored(Effect.flatMap(statement, (rows) => decodeRow(rows[0])));
  const insert = Effect.fnUntraced(function* (row: {
    readonly sessionId: string;
    readonly name: string | null;
    readonly instructions: string | null;
    readonly parentRunId: string;
    readonly task: string;
  }) {
    const id = yield* stored(crypto.randomUUIDv4());
    const now = yield* Clock.currentTimeMillis;
    return yield* returned(
      sql`INSERT INTO subagents ${sql.insert({
        id,
        session_id: row.sessionId,
        name: row.name,
        instructions: row.instructions,
        status: "running",
        parent_run_id: row.parentRunId,
        last_task: row.task,
        created_at: now,
        updated_at: now,
      })} RETURNING *`,
    );
  });
  const startAgain = (
    instructions: string | null,
    parentRunId: string,
    task: string,
    subagentId: string,
  ) =>
    returned(sql`UPDATE subagents SET status = 'running', instructions = ${instructions},
      parent_run_id = ${parentRunId}, last_task = ${task}, error = NULL,
      updated_at = ${effectClock.currentTimeMillisUnsafe()}
      WHERE id = ${subagentId} RETURNING *`);
  const finish = (
    status: SubagentRow["status"],
    answer: string,
    error: string | null,
    subagentId: string,
  ) =>
    stored(sql`UPDATE subagents SET status = ${status}, last_answer = ${answer}, error = ${error},
      updated_at = ${effectClock.currentTimeMillisUnsafe()} WHERE id = ${subagentId}`);
  const byName = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, name: Schema.String }),
    Result: SubagentRow,
    execute: ({ sessionId, name }) =>
      sql`SELECT * FROM subagents WHERE session_id = ${sessionId} AND name = ${name}`,
  });
  const byIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, id: Schema.String }),
    Result: SubagentRow,
    execute: ({ sessionId, id }) =>
      sql`SELECT * FROM subagents WHERE session_id = ${sessionId} AND id = ${id}`,
  });
  const byId = (sessionId: string, id: string) => stored(byIdRow({ sessionId, id }));
  const bySession = SqlSchema.findAll({
    Request: Schema.String,
    Result: SubagentRow,
    execute: (sessionId) =>
      sql`SELECT * FROM subagents WHERE session_id = ${sessionId} ORDER BY created_at, rowid`,
  });

  const serializeNamed = yield* keyedSerialLimit();
  const completions = yield* PubSub.unbounded<string>();
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  /** Controllers indexed independently so archive/delete stops one child, not its parent or peers. */
  type ActiveChild = {
    readonly taskId: string;
    readonly sessionId: string;
    readonly receipt: SubagentReceipt;
    readonly handle: AttemptHandle;
    readonly controller: AbortController;
    readonly settled: Effect.Effect<void>;
    started: boolean;
  };
  const activeChildren = yield* FiberMap.make<string>();
  const childMetadata = MutableHashMap.empty<string, ActiveChild>();
  const liveChildren = () =>
    [...activeChildren].flatMap(([attemptId]) =>
      Option.toArray(MutableHashMap.get(childMetadata, attemptId)),
    );
  /** The latest live attempt of `subagentId`. */
  const activeFor = (
    subagentId: string,
    startedOnly = false,
    exceptAttemptId?: string,
  ): ActiveChild | undefined =>
    Option.getOrUndefined(
      Arr.findLast(
        liveChildren(),
        (child) =>
          child.handle.id !== exceptAttemptId &&
          child.receipt.subagentId === subagentId &&
          (!startedOnly || child.started),
      ),
    );

  /**
   * A child cannot pause its parent's run to ask, so its gated calls wait here instead: the review
   * decides first in `auto` mode, and anything left goes to the user, who answers on the page.
   * Decisions are kept with the parent session's permission reviews. Gives what the call answers
   * instead of running, or none when it may run.
   */
  const relayDecision = (
    binding: SubagentBinding,
    row: SubagentRow,
    handle: AttemptHandle,
    signal: AbortSignal,
    call: { readonly id: string; readonly name: string; readonly written: string },
  ) => {
    const record = (
      decision: "allow" | "ask" | "block" | "approved" | "denied",
      decidedBy: "classifier" | "fallback" | "user",
      reason: string,
    ) =>
      reviews.record({
        sessionId: binding.sessionId,
        toolCallId: `${subagentThreadId(row.id)}:${call.id}`,
        toolName: call.name,
        input: call.written,
        decision,
        decidedBy,
        reason,
      });
    const askUser = (reason: string, askedBy: "review" | "every_call") =>
      Effect.gen(function* () {
        yield* trace.transitionAttempt(
          handle,
          binding.sessionId,
          "waiting",
          "approval_waiting",
          `Waiting for approval: ${call.name}`,
        );
        const decision = yield* relayed.ask(
          binding.sessionId,
          binding.runId,
          {
            requester: ApprovalRequester.cases.subagent.make({
              subagentId: row.id,
              name: row.name,
            }),
            toolName: call.name,
            argumentsJson: call.written,
            reason,
            askedBy,
          },
          signal,
        );
        yield* events.publishSession(binding.sessionId, "relayed-approvals");
        const approved = yield* Fiber.join(decision);
        yield* events.publishSession(binding.sessionId, "relayed-approvals");
        yield* record(
          approved ? "approved" : "denied",
          "user",
          approved ? "사용자가 승인했어요." : "사용자가 거부했어요.",
        );
        yield* trace.transitionAttempt(
          handle,
          binding.sessionId,
          "running",
          "approval_resolved",
          approved ? `Approved: ${call.name}` : `Denied: ${call.name}`,
        );
        return Option.liftPredicate<JsonValue>(
          { approved: false, message: "User denied this action" },
          () => !approved,
        );
      });
    const reviewed = Effect.gen(function* () {
      const verdict = yield* classifier.classify({
        project: binding.project,
        sessionId: binding.sessionId,
        selection: binding.selection,
        toolName: call.name,
        argumentsJson: call.written,
      });
      yield* record(verdict.decision, verdict.decidedBy, verdict.reason);
      return yield* Match.value(verdict.decision).pipe(
        Match.when("allow", () => Effect.succeedNone),
        Match.when("block", () =>
          Effect.succeedSome<JsonValue>({
            error: `blocked_by_permission_review: ${verdict.reason}`,
          }),
        ),
        Match.when("ask", () => askUser(verdict.reason, "review")),
        Match.exhaustive,
      );
    });
    return HashSet.has(binding.gated, call.name)
      ? Match.value(binding.project.permissionMode).pipe(
          Match.when("full", () => Effect.succeedNone),
          Match.when("auto", () => reviewed),
          Match.orElse(() => askUser(everyCallReason, "every_call")),
        )
      : Effect.succeedNone;
  };

  /** A child's call settled; the file a write returned is kept as the attempt's artifact. */
  const callSettled = <A>(
    handle: AttemptHandle,
    sessionId: string,
    call: { readonly id: string; readonly name: string },
    ok: boolean,
    result: A,
  ) =>
    trace.toolSettled(handle, sessionId, call).pipe(
      Effect.andThen(
        Option.match(
          Option.filter(
            Option.liftPredicate(result, Schema.is(FileArtifactResult)),
            () => ok && HashSet.has(fileWriters, call.name),
          ),
          {
            onNone: () => Effect.void,
            onSome: ({ path, sha256 }) =>
              trace.recordArtifact({
                handle,
                kind: "file",
                locator: ArtifactLocator.cases.file.make({ path, sha256 }),
                mediaType: "text/plain",
                verification: "verified",
              }),
          },
        ),
      ),
    );

  /** The model run of a child on the Effect AI loop. */
  const loopChildRun = (
    binding: SubagentBinding,
    row: SubagentRow,
    task: string,
    handle: AttemptHandle,
    signal: AbortSignal,
    tools: ReadonlyArray<RunTool>,
    progress: Ref.Ref<ChildRun>,
  ) =>
    Effect.gen(function* () {
      const threadId = subagentThreadId(row.id);
      const ownTools = [
        ...childRunTools(tools),
        runTool({
          ...readSubagentToolResult,
          handler: (input) =>
            Effect.map(runStore.thread(threadId), (saved) => childResultIn(saved, input)),
        }),
      ];
      // The calls that would wait on the relay gate stay with the child.
      const programs = codeTools.forRunTools(
        ownTools,
        binding.project.permissionMode === "full" ? HashSet.empty() : binding.gated,
      );
      const runtime = yield* active.runtime(binding.selection);
      const model = yield* runtime.model(binding.selection, {
        threadId,
        runId: handle.chatRunId,
        // Same 1-hour cache as the main conversation.
        cacheRetention: "long",
      });
      const started = yield* Ref.make(HashSet.empty<string>());
      const relayGateHook: RunHook = {
        admit: (_scope, call, written) =>
          relayDecision(binding, row, handle, signal, {
            id: call.id,
            name: call.name,
            written,
          }).pipe(
            Effect.map(Option.map((result) => CallOutcome.Returned({ result }))),
            Effect.mapError(asRunFailed),
          ),
      };
      // After the approval gate: a call that reaches here may run, so it stays pending until it
      // settles. A denied or blocked call never reaches here.
      const traceHook: RunHook = {
        admit: (_scope, call) =>
          trace
            .toolStarted(handle, binding.sessionId, { id: call.id, name: call.name })
            .pipe(
              Effect.andThen(Ref.update(started, HashSet.add(call.id))),
              Effect.as(Option.none()),
              Effect.mapError(asRunFailed),
            ),
        answered: (_scope, call, answer) =>
          Effect.when(
            callSettled(handle, binding.sessionId, call, answer._tag === "Returned", answer.result),
            Effect.map(Ref.get(started), HashSet.has(call.id)),
          ).pipe(Effect.asVoid, Effect.mapError(asRunFailed)),
      };
      const childContextHook: RunHook = {
        request: (_scope, request) =>
          runStore.thread(threadId).pipe(
            Effect.map((saved) => ({
              ...request,
              history: compactChildToolResults(request.history, savedToolCallIds(saved)),
            })),
            Effect.mapError(asRunFailed),
          ),
      };
      const hooks: ReadonlyArray<RunHook> = [
        yield* Effect.provideContext(projectInstructionsHook(binding.project.root), platform),
        // Before the gate, so a refused repeat is never reviewed or relayed to the user.
        yield* repeatGuardHook,
        relayGateHook,
        traceHook,
        childContextHook,
        apiUsageHook(usageLedger, {
          rootSessionId: binding.sessionId,
          purpose: "subagent",
          provider: binding.selection.provider,
          model: binding.selection.model,
        }),
      ];
      yield* runChat(
        {
          model: model.model,
          source: model.source,
          system: [...binding.systemPrompts, childInstructions(row.name, row.instructions)],
          tools: [
            ...ownTools.map((tool) => programs.codeSkills(binding.project, tool)),
            programs.runCode,
          ],
          hooks,
          modelFailure: modelFailureOf(model.shownFailure),
        },
        {
          threadId,
          runId: handle.chatRunId,
          conversation: [...(yield* runStore.thread(threadId)), { role: "user", content: task }],
          resume: [],
          cancel: aborted(signal),
        },
      ).pipe(
        Stream.runForEach((event) => Ref.update(progress, (run) => childRunStep(run, event))),
        Effect.provideService(RunStore, runStore),
        Effect.provideService(Crypto.Crypto, crypto),
      );
    }).pipe(Effect.scoped);

  const runChild = (
    binding: SubagentBinding,
    row: SubagentRow,
    task: string,
    handle: AttemptHandle,
    controller: AbortController,
    notifyParentImmediately = false,
  ) =>
    Effect.gen(function* () {
      yield* events.publishSession(binding.sessionId, "subagents");
      const threadId = subagentThreadId(row.id);
      // Named messages may have waited behind another attempt. Publish the task now executing.
      yield* startAgain(row.instructions, binding.runId, task, row.id);
      yield* trace.transitionAttempt(
        handle,
        binding.sessionId,
        "running",
        "attempt_started",
        "Subagent started",
        null,
        notifyParentImmediately,
        binding.runId,
      );
      const progress = yield* Ref.make(childRunStart);
      yield* loopChildRun(
        binding,
        row,
        task,
        handle,
        controller.signal,
        binding.tools,
        progress,
      ).pipe(
        // A failed stream is recorded by code. Defects and interruption end the child run; its
        // launcher records a defect as a crash.
        Effect.catch(() =>
          Ref.update(progress, (run) => ({
            ...run,
            failure: Option.some(AttemptFailureReason.cases.ModelStreamFailed.make({})),
          })),
        ),
      );

      const ran = yield* Ref.get(progress);
      const persisted = yield* runStore.thread(threadId);
      // Where the report's answer is in the child's transcript.
      const answerMessageId = Option.filter(ran.lastMessageId, (id) =>
        persisted.some((message) => message.id === id),
      );
      const answer = Option.getOrElse(
        Option.flatMap(ran.lastMessageId, (id) => HashMap.get(ran.texts, id)),
        () => "",
      );
      const failureCode = Option.getOrNull(Option.map(ran.failure, attemptFailureCode));
      const status = controller.signal.aborted
        ? "cancelled"
        : Option.match(ran.failure, {
            onNone: () => "completed" as const,
            onSome: () => "failed" as const,
          });
      yield* trace.transitionAttempt(
        handle,
        binding.sessionId,
        status,
        attemptEnds[status].event,
        attemptEnds[status].summary,
        Option.getOrNull(Option.map(ran.failure, (reason) => ({ reason }))),
        notifyParentImmediately,
        binding.runId,
        optionalProperty("messageId", Option.getOrUndefined(answerMessageId)),
      );
      yield* finish(status, answer, failureCode, row.id);
      yield* events.publishSession(binding.sessionId, "subagents");
      return {
        status,
        subagentId: row.id,
        agent: row.name,
        taskId: handle.taskId,
        attemptId: handle.id,
        answer,
        error: failureCode,
      } satisfies ChildOutcome;
    });

  type ChildRunFailure = Effect.Error<ReturnType<typeof runChild>>;

  /** Every job belongs to the service scope, not the tool invocation or HTTP request. */
  const launch = (
    binding: SubagentBinding,
    row: SubagentRow,
    task: string,
    handle: AttemptHandle,
    onSettled: (
      outcome: ChildOutcome | null,
    ) => Effect.Effect<unknown, SqlError.SqlError | Schema.SchemaError> = () => Effect.void,
  ) => {
    // Stops the child: the parent's signal, `stopTask` and `stopSession` abort it, and the child's
    // run reads it as its cancel and asks its approvals with it.
    const controller = new AbortController();
    return Effect.gen(function* () {
      const receipt: SubagentReceipt = {
        status: "running",
        subagentId: row.id,
        agent: row.name,
        taskId: handle.taskId,
        attemptId: handle.id,
      };
      const done = yield* Deferred.make<void>();
      const stop = () => controller.abort(binding.abortSignal.reason);
      binding.abortSignal.addEventListener("abort", stop, { once: true });
      if (binding.abortSignal.aborted) stop();
      const child: ActiveChild = {
        taskId: handle.taskId,
        sessionId: binding.sessionId,
        receipt,
        handle,
        controller,
        settled: Deferred.await(done),
        started: false,
      };
      // The child's run once it started. Interrupting `work` aborts `controller` instead of the
      // run, which records its outcome before it ends.
      const running = yield* Ref.make(Option.none<Fiber.Fiber<ChildOutcome, ChildRunFailure>>());
      const work = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          child.started = true;
          const run = yield* Effect.forkScoped(runChild(binding, row, task, handle, controller));
          yield* Ref.set(running, Option.some(run));
          return yield* restore(Fiber.join(run)).pipe(
            Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          );
        }),
      ).pipe(
        // The child's runtime died before it recorded an outcome. The tag, not the cause's text,
        // is kept: that can hold paths or provider bodies.
        Effect.catchCauseIf(Predicate.not(Cause.hasInterrupts), () =>
          Effect.gen(function* () {
            yield* trace.transitionAttempt(
              handle,
              binding.sessionId,
              "failed",
              "attempt_failed",
              "Subagent crashed",
              { reason: AttemptFailureReason.cases.AgentCrashed.make({}) },
              false,
              binding.runId,
            );
            yield* finish("failed", "", "AgentCrashed", row.id);
          }),
        ),
        // Keep the named-agent permit until the child's run has stopped and recorded its
        // outcome. Releasing on Effect interruption alone would let the next message overlap it.
        Effect.ensuring(
          // Waits for the run to settle; its outcome was recorded by `work`.
          Effect.flatMap(
            Ref.get(running),
            Option.match({ onNone: () => Effect.void, onSome: Fiber.await }),
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                child.started = false;
              }),
            ),
          ),
        ),
      );
      const cancelled = Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => controller.signal.removeEventListener("abort", abort));
      });
      const job = Effect.raceFirst(serializeNamed(row.id, work), cancelled).pipe(
        Effect.ensuring(
          // Interruption aborts the child's signal; retain the service until the outcome is
          // recorded.
          Effect.flatMap(
            Ref.get(running),
            Option.match({
              onSome: (run) =>
                Effect.map(Fiber.await(run), (exit) => (Exit.isSuccess(exit) ? exit.value : null)),
              onNone: () =>
                trace
                  .transitionAttempt(
                    handle,
                    binding.sessionId,
                    "cancelled",
                    "attempt_cancelled",
                    "Queued subagent cancelled",
                    null,
                    false,
                    binding.runId,
                  )
                  .pipe(Effect.as(null)),
            }),
          ).pipe(
            Effect.flatMap(onSettled),
            Effect.ensuring(
              Effect.gen(function* () {
                binding.abortSignal.removeEventListener("abort", stop);
                const started = Option.isSome(yield* Ref.get(running));
                if (!(activeFor(row.id, false, handle.id) !== undefined) && !started)
                  // A finalizer cannot fail: a store failure is logged by tag, and the waiters
                  // and the page still learn the child settled.
                  yield* finish("cancelled", "", null, row.id).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("subagent_cancel_not_recorded", {
                        error: errorTag(error),
                      }),
                    ),
                  );
              }).pipe(
                Effect.ensuring(Deferred.succeed(done, undefined)),
                Effect.andThen(events.publishSession(binding.sessionId, "subagents")),
                Effect.andThen(PubSub.publish(completions, binding.sessionId)),
              ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("subagent_settlement_not_recorded", {
                error: errorTag(error),
              }),
            ),
          ),
        ),
      );
      MutableHashMap.set(childMetadata, handle.id, child);
      // The attempt beats while its fiber lives, queued or running. If the fiber ends without
      // settling the attempt, the beats stop and the store's watchdog fails it as lost.
      yield* FiberMap.run(
        activeChildren,
        handle.id,
        Effect.forkScoped(trace.keepAlive(handle)).pipe(
          Effect.andThen(job),
          Effect.scoped,
          Effect.ensuring(Effect.sync(() => MutableHashMap.remove(childMetadata, handle.id))),
        ),
      );
      return receipt;
    });
  };

  const startOneOff = Effect.fnUntraced(function* (
    binding: SubagentBinding,
    parentToolCallId: string,
    task: string,
    instructions: string | null,
  ) {
    const row = yield* insert({
      sessionId: binding.sessionId,
      name: null,
      instructions,
      parentRunId: binding.runId,
      task,
    });
    const handle = yield* trace.startAttempt({
      sessionId: binding.sessionId,
      parentRunId: binding.runId,
      parentToolCallId,
      agentId: row.id,
      title: task.replace(/\s+/gu, " ").trim().slice(0, 80),
      request: task,
      kind: "start",
      threadId: subagentThreadId(row.id),
    });
    return yield* launch(binding, row, task, handle);
  });

  /** Creates or continues a named child and starts its next traced attempt. */
  const namedAttempt = Effect.fnUntraced(function* (
    binding: SubagentBinding,
    parentToolCallId: string,
    agent: string,
    message: string,
    instructions: string | undefined,
  ) {
    // One transaction: two calls naming the same new agent must not both insert it.
    const { row, kind } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* stored(byName({ sessionId: binding.sessionId, name: agent }));
        return yield* Option.match(existing, {
          onNone: () =>
            Effect.map(
              insert({
                sessionId: binding.sessionId,
                name: agent,
                instructions: instructions ?? null,
                parentRunId: binding.runId,
                task: message,
              }),
              (row) => ({ row, kind: "start" as const }),
            ),
          onSome: (known) =>
            Effect.map(
              startAgain(
                instructions === undefined ? known.instructions : instructions,
                binding.runId,
                message,
                known.id,
              ),
              (row) => ({ row, kind: "continue" as const }),
            ),
        });
      }),
    );
    const handle = yield* trace.startAttempt({
      sessionId: binding.sessionId,
      parentRunId: binding.runId,
      parentToolCallId,
      agentId: row.id,
      title: message.replace(/\s+/gu, " ").trim().slice(0, 80),
      request: message,
      kind,
      threadId: subagentThreadId(row.id),
    });
    return { row, handle };
  });

  const startNamed = Effect.fnUntraced(function* (
    binding: SubagentBinding,
    parentToolCallId: string,
    agent: string,
    message: string,
    instructions: string | undefined,
  ) {
    const { row, handle } = yield* namedAttempt(
      binding,
      parentToolCallId,
      agent,
      message,
      instructions,
    );
    return yield* launch(binding, row, message, handle);
  });

  /** Starts the attempt a resume claimed, unless its agent was removed. */
  const resumeStarted = Effect.fnUntraced(function* (
    binding: SubagentBinding,
    taskId: string,
    claim: Data.TaggedEnum.Value<ResumeClaim, "started">,
  ) {
    const existing = yield* byId(binding.sessionId, claim.agentId);
    return yield* Option.match(existing, {
      onNone: () =>
        Effect.succeed<SubagentReport>({
          status: "resume_blocked",
          taskId,
          reason: "agent_not_found",
        }),
      onSome: (known) =>
        startAgain(known.instructions, binding.runId, claim.context.originalRequest, known.id).pipe(
          Effect.flatMap((row) => launch(binding, row, retryMessage(claim.context), claim.handle)),
        ),
    });
  });

  const resumeTask = Effect.fnUntraced(function* (
    binding: SubagentBinding,
    parentToolCallId: string,
    input: typeof ResumeSubagentInput.Type,
  ) {
    const claim = yield* trace.claimResume({
      sessionId: binding.sessionId,
      taskId: input.taskId,
      expectedAttemptId: input.expectedAttemptId,
      parentRunId: binding.runId,
      parentToolCallId,
      confirmUncertain: input.confirmUncertain,
    });
    return yield* ResumeClaim.$match(claim, {
      blocked: ({ reason }) =>
        Effect.succeed<SubagentReport>({ status: "resume_blocked", taskId: input.taskId, reason }),
      started: (started) => resumeStarted(binding, input.taskId, started),
    });
  });

  /** Starts the retries the user asked for from Work Trace since the parent's last run. */
  const retryForRun = (binding: SubagentBinding) =>
    trace.claimRetries(binding.sessionId, binding.runId).pipe(
      Effect.flatMap((claims) =>
        Effect.forEach(
          claims,
          (claim) =>
            Effect.gen(function* () {
              const existing = yield* byId(binding.sessionId, claim.agentId);
              yield* Option.match(existing, {
                // The agent was removed after the retry was claimed: end the queued attempt.
                onNone: () =>
                  trace.transitionAttempt(
                    claim.handle,
                    binding.sessionId,
                    "cancelled",
                    "attempt_cancelled",
                    "Subagent no longer exists",
                    null,
                    true,
                    binding.runId,
                  ),
                onSome: (known) =>
                  startAgain(
                    known.instructions,
                    binding.runId,
                    claim.context.originalRequest,
                    known.id,
                  ).pipe(
                    Effect.flatMap((row) =>
                      launch(binding, row, retryMessage(claim.context), claim.handle),
                    ),
                  ),
              });
            }),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  const attemptState = (sessionId: string, taskId: string, attemptId: string) =>
    trace.taskDetail(sessionId, taskId).pipe(
      Effect.flatMap((found) =>
        Effect.fromOption(
          Option.fromNullishOr(found).pipe(
            Option.filter(
              (detail) => detail.task.deletedAt === null && detail.task.deleteRequestedAt === null,
            ),
            Option.flatMap((detail) =>
              Option.map(
                Arr.findFirst(detail.attempts, (candidate) => candidate.id === attemptId),
                (attempt) => ({ detail, attempt }),
              ),
            ),
          ),
          () =>
            WorkTraceRejected.make({
              reason: "attempt_not_found",
              message: "Subagent attempt not found in this session",
            }),
        ),
      ),
    );
  const terminal = (status: string) => !["queued", "running", "waiting"].includes(status);
  const getReport = Effect.fnUntraced(function* (
    sessionId: string,
    taskId: string,
    attemptId: string,
  ) {
    const { detail, attempt } = yield* attemptState(sessionId, taskId, attemptId);
    const gone = () => new Cause.UnknownError(new Error("Subagent no longer exists"));
    const subagentId = yield* Effect.fromOption(
      Option.liftPredicate(detail.task.agentId, isTruthy),
      gone,
    );
    const row = yield* Effect.flatMap(byId(sessionId, subagentId), (found) =>
      Effect.fromOption(found, gone),
    );
    const base = { subagentId, agent: row.name, taskId, attemptId };
    const settled = Effect.map(runStore.thread(attempt.threadId), (messages): SubagentReport => {
      // The attempt's terminal event names its last assistant message.
      const answerId = detail.events.findLast(
        (event) => event.attemptId === attemptId && isAnswerPayload(event.payload),
      )?.payload;
      const message = isAnswerPayload(answerId)
        ? messages.find((entry) => entry.role === "assistant" && entry.id === answerId.messageId)
        : undefined;
      const answer = Schema.is(Schema.String)(message?.content)
        ? message.content
        : (message?.content ?? [])
            .flatMap((part) => (part.type === "text" ? [part.content] : []))
            .join("");
      return {
        ...base,
        status:
          attempt.status === "completed"
            ? "completed"
            : attempt.status === "cancelled"
              ? "cancelled"
              : attempt.status === "failed"
                ? "failed"
                : "interrupted",
        answer,
        error: attempt.failure === null ? null : attemptFailureCode(attempt.failure.reason),
      };
    });
    return yield* terminal(attempt.status)
      ? settled
      : Effect.succeed<SubagentReport>({ ...base, status: "running" });
  });

  /** What a parent run's dispatch of a subagent task can fail with. */
  type DispatchFailure =
    | Effect.Error<ReturnType<typeof startNamed>>
    | Effect.Error<ReturnType<typeof resumeTask>>;

  /**
   * One parent run's subagent calls, and what the run reviewed, was told and adopted. Dispatch is
   * nonblocking; only explicit retrieval marks a report reviewed in this run.
   */
  const parentRun = Effect.fnUntraced(function* (binding: SubagentBinding) {
    const started = yield* SynchronizedRef.make(
      HashMap.empty<string, Fiber.Fiber<SubagentReport, DispatchFailure>>(),
    );
    const reviewed = yield* Ref.make(HashSet.empty<string>());
    const deliveredNotificationIds = yield* Ref.make(binding.deliveredParentNotificationIds);
    const adoptionDraft = yield* Ref.make(Option.none<AdoptionDraft>());

    /**
     * Starts the call's task once; the same call asked again gets the same report. The task
     * belongs to the service, not to the tool call that started it.
     */
    const dispatch = (toolCallId: string, task: Effect.Effect<SubagentReport, DispatchFailure>) =>
      SynchronizedRef.modifyEffect(started, (fibers) =>
        Option.match(HashMap.get(fibers, toolCallId), {
          onSome: (fiber) => Effect.succeed([fiber, fibers] as const),
          onNone: () =>
            Effect.map(
              Effect.forkIn(task, scope),
              (fiber) => [fiber, HashMap.set(fibers, toolCallId, fiber)] as const,
            ),
        }),
      ).pipe(Effect.flatMap(Fiber.join));

    const unadoptable = Effect.fnUntraced(function* (draft: AdoptionDraft) {
      const reviewedReports = yield* Ref.get(reviewed);
      const delivered = yield* Ref.get(deliveredNotificationIds);
      const notReviewed = ({ taskId, attemptId }: AdoptionDraft["reports"][number]) =>
        !HashSet.has(reviewedReports, `${taskId}:${attemptId}`);
      const notDelivered = (id: string) => !HashSet.has(delivered, id);
      return draft.reports.some(notReviewed)
        ? Option.some<SubagentAdoptionRejected["reason"]>("NotReviewed")
        : draft.reflectedNotificationIds.some(notDelivered)
          ? Option.some<SubagentAdoptionRejected["reason"]>("NotificationNotDelivered")
          : Option.none<SubagentAdoptionRejected["reason"]>();
    });

    return {
      run: (toolCallId: string, input: typeof RunSubagentInput.Type) => {
        // Ownership and acceptance belong to this task: a one-off keeps them as its standing
        // instructions, a named helper gets them with the message.
        const taskTerms = [
          isTruthy(input.ownership?.length)
            ? `Owned files/areas: ${input.ownership.join(", ")}. Preserve other agents' edits.`
            : null,
          isTruthy(input.acceptanceCriteria?.length)
            ? `Acceptance criteria:\n${input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
            : null,
        ].filter((part) => part !== null);
        return dispatch(
          toolCallId,
          isTruthy(input.agent)
            ? startNamed(
                binding,
                toolCallId,
                input.agent,
                [input.task, ...taskTerms].join("\n\n"),
                input.instructions,
              )
            : startOneOff(
                binding,
                toolCallId,
                input.task,
                [input.instructions, ...taskTerms]
                  .filter((part) => part !== undefined)
                  .join("\n") || null,
              ),
        );
      },

      resume: (toolCallId: string, input: typeof ResumeSubagentInput.Type) =>
        dispatch(toolCallId, resumeTask(binding, toolCallId, input)),

      reports: ({ attempts }: typeof AttemptsInput.Type) =>
        Effect.forEach(
          attempts,
          ({ taskId, attemptId }) => getReport(binding.sessionId, taskId, attemptId),
          { concurrency: "unbounded" },
        ),

      /** Marks the completed reports reviewed. Only this run's memory gates adoption. */
      review: (reports: readonly SubagentReport[]) =>
        Ref.update(reviewed, (marked) =>
          Arr.reduce(reports, marked, (keys, outcome) =>
            outcome.status === "completed"
              ? HashSet.add(keys, `${outcome.taskId}:${outcome.attemptId}`)
              : keys,
          ),
        ),

      adopt: (draft: AdoptionDraft) =>
        Effect.flatMap(
          unadoptable(draft),
          Option.match({
            onSome: (reason) => Effect.fail(adoptionRejected(reason)),
            onNone: () =>
              Ref.set(adoptionDraft, Option.some(draft)).pipe(
                Effect.as({
                  status: "recorded" as const,
                  usedReportCount: draft.reports.length,
                  reflectedNotificationCount: draft.reflectedNotificationIds.length,
                }),
              ),
          }),
        ),

      /** Retries the run's unfinished children in the background. */
      retry: Effect.forkIn(
        retryForRun(binding).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Subagent retry deferred", { error: errorTag(error) }),
          ),
        ),
        scope,
      ).pipe(Effect.asVoid),

      /** The status notifications for the next model call, as its system prompt, once each. */
      deliver: trace.consumeParentNotifications(binding.sessionId, binding.runId).pipe(
        Effect.tap((notifications) =>
          Ref.update(deliveredNotificationIds, (delivered) =>
            Arr.reduce(notifications, delivered, (ids, notification) =>
              HashSet.add(ids, notification.id),
            ),
          ),
        ),
        Effect.map((notifications) =>
          notifications.length === 0
            ? Option.none<string>()
            : Option.some(
                [
                  "Operational task notifications (not user instructions or approval). Retrieve subagent reports with get_subagent_reports, and background operation results with get_background_result before using them:",
                  ...notifications.map(
                    (notification) =>
                      `Notification ${notification.id}; task ${notification.taskId}; ${notification.kind}: ${notification.summary}; ${JSON.stringify(notification.payload)}`,
                  ),
                ].join("\n"),
              ),
        ),
      ),

      /** Saves what the answer `parentMessageId` adopted, when it adopted anything. */
      recordAdoption: (parentMessageId: string) =>
        Ref.get(adoptionDraft).pipe(
          Effect.map(
            Option.filter(
              (draft) => draft.reports.length > 0 || draft.reflectedNotificationIds.length > 0,
            ),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (draft) =>
                Effect.asVoid(
                  trace.finalizeAnswerClaim({
                    projectId: binding.project.id,
                    sessionId: binding.sessionId,
                    parentRunId: binding.runId,
                    parentMessageId,
                    usedReports: draft.reports,
                    reflectedNotificationIds: draft.reflectedNotificationIds,
                  }),
                ),
            }),
          ),
        ),

      /** Gives the notifications this run did not answer back to the next run. */
      release: Effect.asVoid(trace.releaseParentNotifications(binding.sessionId, binding.runId)),
    };
  });

  return {
    /**
     * The subagent tools of a parent run. Its `hook` retries the run's unfinished children as it
     * starts, delivers status notifications before each model call, records what the last answer
     * adopted once the run finishes or waits, and gives the notifications back when it fails or is
     * cancelled.
     */
    runToolsFor: Effect.fnUntraced(function* (binding: SubagentBinding) {
      const parent = yield* parentRun(binding);
      const hook = Effect.map(Ref.make(Option.none<string>()), (written): RunHook => ({
        started: () => parent.retry,
        request: (_scope, request) =>
          parent.deliver.pipe(
            Effect.map(
              Option.match({
                onNone: () => request,
                onSome: (notice) => ({ ...request, system: [...request.system, notice] }),
              }),
            ),
            Effect.mapError(asRunFailed),
          ),
        stepEnded: (_scope, step) =>
          StepEnded.$match(step, {
            Model: ({ message }) => Ref.set(written, Option.fromNullishOr(message.id)),
            Resume: () => Effect.void,
          }),
        ended: (_scope, end) =>
          (finishedRun(end)
            ? Effect.flatMap(
                Ref.get(written),
                Option.match({ onNone: () => Effect.void, onSome: parent.recordAdoption }),
              )
            : parent.release
          ).pipe(Effect.ignore({ log: "Warn" })),
      }));
      return {
        tools: [
          runTool({
            ...runSubagent,
            handler: (input, { toolCallId }) => parent.run(toolCallId, input),
          }),
          runTool({
            ...resumeSubagent,
            lazy: true,
            handler: (input, { toolCallId }) => parent.resume(toolCallId, input),
          }),
          runTool({
            ...getSubagentReports,
            handler: (input) =>
              parent.reports(input).pipe(Effect.tap(parent.review), Effect.map(reportsAnswer)),
          }),
          runTool({ ...adoptSubagentReports, handler: parent.adopt }),
        ],
        hook,
      };
    }),

    /**
     * Runs one attempt of a named child that no parent chat run started, such as a kanban card's
     * agent, and waits for its outcome. `register` sees the attempt before the child can call a
     * tool; when it fails the child never starts. Interrupting the effect stops the child and
     * waits until its outcome is recorded.
     */
    runAttempt: <E>(
      binding: Omit<SubagentBinding, "abortSignal" | "deliveredParentNotificationIds">,
      attempt: { readonly agent: string; readonly message: string; readonly instructions: string },
      register: (handle: AttemptHandle) => Effect.Effect<void, E>,
    ) =>
      Effect.gen(function* () {
        const settled = yield* Deferred.make<ChildOutcome | null>();
        const launched = yield* Ref.make(false);
        const run = Effect.gen(function* () {
          // Closing this scope aborts the signal, which stops the child.
          const owned: SubagentBinding = {
            ...binding,
            abortSignal: yield* Effect.abortSignal,
            deliveredParentNotificationIds: HashSet.empty(),
          };
          const { row, handle } = yield* namedAttempt(
            owned,
            binding.runId,
            attempt.agent,
            attempt.message,
            attempt.instructions,
          );
          yield* register(handle).pipe(
            Effect.tapError(() =>
              trace
                .transitionAttempt(
                  handle,
                  binding.sessionId,
                  "cancelled",
                  "attempt_cancelled",
                  "Subagent not started",
                  null,
                  false,
                  binding.runId,
                )
                .pipe(Effect.andThen(finish("cancelled", "", null, row.id))),
            ),
          );
          yield* Ref.set(launched, true);
          yield* launch(owned, row, attempt.message, handle, (outcome) =>
            Deferred.succeed(settled, outcome),
          );
          return yield* Deferred.await(settled);
        });
        // A launched child always settles, also after its signal is aborted.
        return yield* Effect.scoped(run).pipe(
          Effect.onInterrupt(() => Effect.when(Deferred.await(settled), Ref.get(launched))),
        );
      }),

    /** The session of each child as it settles. */
    completions: Stream.fromPubSub(completions),

    /** Stop all session children, including those whose parent finished normally. */
    stopSession: (sessionId: string) =>
      Effect.gen(function* () {
        const entries = liveChildren().filter((child) => child.sessionId === sessionId);
        yield* Effect.sync(() =>
          entries.forEach((entry) => entry.controller.abort(new Error("session_cancel_requested"))),
        );
        yield* Effect.forEach(entries, (entry) => entry.settled, {
          concurrency: "unbounded",
          discard: true,
        });
      }),

    /** Stop exactly one live child and wait until its terminal transition settles. */
    stopTask: (taskId: string) =>
      Effect.suspend(() =>
        Option.match(
          Arr.findFirst(liveChildren(), (child) => child.taskId === taskId),
          {
            onNone: () => Effect.succeed("not_running" as const),
            onSome: (entry) =>
              Effect.sync(() => entry.controller.abort(new Error("task_lifecycle_requested"))).pipe(
                Effect.andThen(entry.settled),
                Effect.as("stopped" as const),
              ),
          },
        ),
      ),

    /** Children of a session. Their calls waiting for the user are in `RelayedApprovals`. */
    list: (sessionId: string) =>
      stored(bySession(sessionId)).pipe(Effect.map((rows) => rows.map(toView))),

    /** A child's saved conversation. */
    transcript: (sessionId: string, subagentId: string) =>
      Effect.flatMap(
        byId(sessionId, subagentId),
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (found) =>
            Effect.map(runStore.thread(subagentThreadId(subagentId)), (messages) => ({
              subagent: toView(found),
              messages,
            })),
        }),
      ),
  };
});

/** Child agents a run delegates to (R18): one-off and named, never nested. */
export class Subagents extends Context.Service<Subagents, Effect.Success<typeof make>>()(
  "memory-agent/subagents/subagents",
) {
  static readonly layer = Layer.effect(Subagents, make).pipe(Layer.provide(NodeCrypto.layer));
}
