import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Array as EffectArray } from "effect";
import { isTruthy } from "../truthy.ts";
import { logFailure } from "../runtime/logged-failures.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  MutableHashMap,
  DateTime,
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  PubSub,
  Schema,
} from "effect";
import { SqlClient, type Statement } from "effect/sql";
import { JsonValue } from "../json.ts";
import type { MemoryCandidateView, MemoryUsageView } from "../memory/knowledge.ts";
import {
  ArtifactKind,
  ArtifactLocator,
  AttemptFailure,
  AttemptFailureReason,
  type AttemptFailureStage,
  AttemptStatus,
  EvidenceVerification,
  HeartbeatState,
  type InvocationKind,
  RedactionState,
  RunEventKind,
  TaskStatus,
  TraceVisibility,
  canTransitionAttempt,
  type ArtifactLocator as ArtifactLocatorValue,
} from "./contracts.ts";

/** How often a live attempt beats, and how long without a beat makes it lost. */
export const heartbeatIntervalMs = 10_000;
export const heartbeatLostMs = 60_000;

const ReadFailed = Schema.TaggedStruct("ReadFailed", {});

/** What trace readers wait for: a new event of a session, or progress a heartbeat reported. */
type TraceChange =
  | { readonly kind: "event"; readonly sessionId: string; readonly cursor: number }
  | { readonly kind: "progress"; readonly sessionId: string };

export class WorkTraceReadFailed extends Schema.TaggedError<
  WorkTraceReadFailed,
  { readonly brand: unique symbol }
>()("WorkTraceReadFailed", {
  operation: Schema.Literals(["latest_cursor", "snapshot"]),
  reason: ReadFailed,
  cause: Schema.Defect(),
}) {}

/** A Work Trace write the store refused; `message` is safe to show the model. */
export class WorkTraceRejected extends Schema.TaggedError<
  WorkTraceRejected,
  { readonly brand: unique symbol }
>()("WorkTraceRejected", {
  reason: Schema.Literals([
    "handle_mismatch",
    "unsafe_file_path",
    "missing_file_digest",
    "artifact_kind_mismatch",
    "origin_missing",
    "invalid_transition",
    "foreign_session",
    "foreign_report",
    "undelivered_notification",
    "attempt_not_found",
  ]),
  message: Schema.String,
}) {}
const rejected = (reason: WorkTraceRejected["reason"], message: string) =>
  WorkTraceRejected.make({ reason, message });

const AttemptRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  invocation_id: Schema.String,
  attempt_number: Schema.Finite,
  chat_run_id: Schema.String,
  thread_id: Schema.String,
  status: AttemptStatus,
});
const RecoveryRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
});
const PendingToolsRow = Schema.Struct({ pending_tool_call_ids: Schema.String });
const RetryRow = Schema.Struct({
  id: Schema.String,
  previous_attempt_id: Schema.String,
  retry_confirm_uncertain: Schema.Finite,
});
const LostAttemptRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  invocation_id: Schema.String,
  attempt_number: Schema.Finite,
  chat_run_id: Schema.String,
  thread_id: Schema.String,
  status: AttemptStatus,
  origin_session_id: Schema.NullOr(Schema.String),
});
const NotificationTaskRow = Schema.Struct({
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
});
const ParentNotificationRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.String,
  created_at: Schema.Finite,
});
const SequenceRow = Schema.Struct({ sequence: Schema.Finite });
const CursorRow = Schema.Struct({ seq: Schema.Finite });
const IdRow = Schema.Struct({ id: Schema.String });
const TaskIdRow = Schema.Struct({ task_id: Schema.String });
const AttemptNumberRow = Schema.Struct({ attempt_number: Schema.Finite });
const LifecycleOperationRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  target_kind: Schema.Literals(["task", "session"]),
  target_id: Schema.String,
  intent: Schema.Literals(["archive", "restore", "delete"]),
  status: Schema.Literals([
    "requested",
    "cancelling",
    "waiting_for_stop",
    "purging",
    "completed",
    "blocked",
    "failed",
  ]),
  idempotency_key: Schema.String,
  blocker: Schema.NullOr(Schema.String),
  requested_at: Schema.Finite,
  updated_at: Schema.Finite,
  completed_at: Schema.NullOr(Schema.Finite),
});
const LifecycleTaskRow = Schema.Struct({
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Finite),
  delete_requested_at: Schema.NullOr(Schema.Finite),
  deleted_at: Schema.NullOr(Schema.Finite),
  purge_receipt_id: Schema.NullOr(Schema.String),
});
const TaskViewRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_task_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  parent_tool_call_id: Schema.String,
  agent_id: Schema.NullOr(Schema.String),
  agent_name: Schema.String,
  status: TaskStatus,
  title: Schema.String,
  request: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  latest_attempt_id: Schema.NullOr(Schema.String),
  latest_attempt_status: Schema.NullOr(AttemptStatus),
  latest_attempt_number: Schema.NullOr(Schema.Finite),
  latest_resumed_from_attempt_id: Schema.NullOr(Schema.String),
  heartbeat_state: Schema.NullOr(HeartbeatState),
  heartbeat_step: Schema.NullOr(Schema.String),
  heartbeat_at: Schema.NullOr(Schema.Finite),
  latest_failure: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Finite),
  delete_requested_at: Schema.NullOr(Schema.Finite),
  deleted_at: Schema.NullOr(Schema.Finite),
  purge_receipt_id: Schema.NullOr(Schema.String),
  updated_at: Schema.Finite,
  created_at: Schema.Finite,
});
const AttemptViewRow = Schema.Struct({
  id: Schema.String,
  invocation_id: Schema.String,
  attempt_number: Schema.Finite,
  chat_run_id: Schema.String,
  thread_id: Schema.String,
  status: AttemptStatus,
  resumed_from_attempt_id: Schema.NullOr(Schema.String),
  superseded_by_attempt_id: Schema.NullOr(Schema.String),
  heartbeat_state: Schema.NullOr(HeartbeatState),
  heartbeat_step: Schema.NullOr(Schema.String),
  heartbeat_at: Schema.NullOr(Schema.Finite),
  pending_tool_call_ids: Schema.String,
  failure: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.Finite),
  finished_at: Schema.NullOr(Schema.Finite),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});
const ResumeTaskRow = Schema.Struct({
  id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  request: Schema.String,
  status: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Finite),
  delete_requested_at: Schema.NullOr(Schema.Finite),
  deleted_at: Schema.NullOr(Schema.Finite),
  previous_attempt_id: Schema.String,
  previous_attempt_number: Schema.Finite,
  previous_status: AttemptStatus,
  thread_id: Schema.String,
});
const ArtifactRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
  kind: ArtifactKind,
  locator: Schema.NullOr(Schema.String),
  media_type: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  source_deleted_at: Schema.NullOr(Schema.Finite),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
});
const FinalAnswerClaimRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  parent_message_id: Schema.String,
  created_at: Schema.Finite,
});
const FinalAnswerSourceRow = Schema.Struct({
  id: Schema.String,
  claim_id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
});
const FinalAnswerNotificationRow = Schema.Struct({
  claim_id: Schema.String,
  notification_id: Schema.String,
  task_id: Schema.String,
});
const StoredEventRow = Schema.Struct({
  cursor: Schema.Finite,
  id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  task_id: Schema.String,
  invocation_id: Schema.String,
  attempt_id: Schema.String,
  attempt_sequence: Schema.Finite,
  kind: RunEventKind,
  visibility: TraceVisibility,
  redaction: RedactionState,
  summary: Schema.String,
  payload: Schema.String,
  occurred_at: Schema.Finite,
});
const SessionLifecycleRow = Schema.Struct({
  project_id: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
});
const PendingLifecycleRow = Schema.Struct({
  id: Schema.String,
  target_kind: Schema.Literals(["task", "session"]),
  target_id: Schema.String,
  intent: Schema.Literals(["archive", "restore", "delete"]),
});
const decodeAttempt = Schema.decodeUnknownEffect(AttemptRow);
const decodeRecoveryRows = Schema.decodeUnknownEffect(Schema.Array(RecoveryRow));
const decodePendingTools = Schema.decodeUnknownEffect(PendingToolsRow);
const decodeRetryRows = Schema.decodeUnknownEffect(Schema.Array(RetryRow));
const decodeLostAttemptRows = Schema.decodeUnknownEffect(Schema.Array(LostAttemptRow));
const decodeStringArray = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeFailure = Schema.decodeUnknownEffect(Schema.fromJsonString(AttemptFailure));
const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(AttemptFailure));
const decodeNotificationTask = Schema.decodeUnknownEffect(NotificationTaskRow);
const decodeParentNotificationRows = Schema.decodeUnknownEffect(
  Schema.Array(ParentNotificationRow),
);
const decodeSequence = Schema.decodeUnknownEffect(SequenceRow);
const decodeCursor = Schema.decodeUnknownEffect(CursorRow);
const decodeId = Schema.decodeUnknownEffect(IdRow);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(IdRow));
const decodeTaskId = Schema.decodeUnknownEffect(TaskIdRow);
const decodeAttemptNumber = Schema.decodeUnknownEffect(AttemptNumberRow);
const decodeLifecycleOperation = Schema.decodeUnknownEffect(LifecycleOperationRow);
const decodeLifecycleTask = Schema.decodeUnknownEffect(LifecycleTaskRow);
const decodeTaskViewRows = Schema.decodeUnknownEffect(Schema.Array(TaskViewRow));
const decodeAttemptViewRows = Schema.decodeUnknownEffect(Schema.Array(AttemptViewRow));
const decodeStoredEventRows = Schema.decodeUnknownEffect(Schema.Array(StoredEventRow));
const decodeResumeTask = Schema.decodeUnknownEffect(ResumeTaskRow);
const decodeArtifactRows = Schema.decodeUnknownEffect(Schema.Array(ArtifactRow));
const decodeArtifactRow = Schema.decodeUnknownEffect(ArtifactRow);
const decodeFinalAnswerClaimRows = Schema.decodeUnknownEffect(Schema.Array(FinalAnswerClaimRow));
const decodeFinalAnswerSourceRows = Schema.decodeUnknownEffect(Schema.Array(FinalAnswerSourceRow));
const decodeFinalAnswerNotificationRows = Schema.decodeUnknownEffect(
  Schema.Array(FinalAnswerNotificationRow),
);
const decodeSessionLifecycle = Schema.decodeUnknownEffect(Schema.UndefinedOr(SessionLifecycleRow));
const decodeRunIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ run_id: Schema.String })),
);
const decodePendingLifecycleRows = Schema.decodeUnknownEffect(Schema.Array(PendingLifecycleRow));
const decodeOriginSessions = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin_session_id: Schema.String })),
);
const decodeArtifactLocator = Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactLocator));
const decodeRunResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    changes: Schema.Finite,
    lastInsertRowid: Schema.Union([Schema.Finite, Schema.BigInt]),
  }),
);
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValue));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeArtifactLocator = Schema.encodeEffect(Schema.fromJsonString(ArtifactLocator));

export interface TraceTaskView {
  readonly id: string;
  readonly projectId: string;
  readonly originSessionId: string | null;
  readonly parentTaskId: string | null;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly agentId: string | null;
  readonly agentName: string;
  readonly status: TaskStatus;
  readonly title: string;
  readonly request: string;
  readonly activeAttemptId: string | null;
  readonly latestAttemptId: string | null;
  readonly latestAttemptStatus: AttemptStatus | null;
  readonly latestAttemptNumber: number | null;
  readonly latestResumedFromAttemptId: string | null;
  /** Where the latest attempt is, as its last heartbeat said. */
  readonly heartbeat: TraceHeartbeatView | null;
  /** Why the latest attempt failed, if it did. */
  readonly latestFailure: AttemptFailure | null;
  readonly archivedAt: number | null;
  readonly deleteRequestedAt: number | null;
  readonly deletedAt: number | null;
  readonly purgeReceiptId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TraceAttemptView {
  readonly id: string;
  readonly invocationId: string;
  readonly attemptNumber: number;
  readonly chatRunId: string;
  readonly threadId: string;
  readonly status: AttemptStatus;
  readonly resumedFromAttemptId: string | null;
  readonly supersededByAttemptId: string | null;
  readonly heartbeat: TraceHeartbeatView | null;
  /** Tool calls the attempt started and never settled. */
  readonly pendingToolCallIds: readonly string[];
  readonly failure: AttemptFailure | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TraceHeartbeatView {
  readonly state: HeartbeatState;
  /** One line about the current step. */
  readonly step: string | null;
  readonly at: number;
}

export interface TraceTreeSnapshot {
  readonly cursor: number;
  readonly tasks: readonly TraceTaskView[];
}

export interface TraceTaskDetail {
  readonly task: TraceTaskView;
  readonly attempts: readonly TraceAttemptView[];
  readonly artifacts: readonly TraceArtifactView[];
  readonly answerClaims: readonly TraceFinalAnswerClaimView[];
  /** Present on HTTP detail projections; omitted by the lower-level trace store. */
  readonly memoryCandidates?: readonly MemoryCandidateView[];
  /** Retrieval and actual-use events are separate so recall does not imply answer influence. */
  readonly memoryUsage?: readonly MemoryUsageView[];
  readonly events: readonly TraceEventView[];
}

export interface TraceFinalAnswerClaimView {
  readonly id: string;
  readonly projectId: string;
  readonly originSessionId: string | null;
  readonly parentRunId: string;
  readonly parentMessageId: string;
  readonly sources: readonly {
    readonly taskId: string;
    readonly attemptId: string;
  }[];
  readonly notificationIds: readonly string[];
  readonly createdAt: number;
}

export interface TraceArtifactView {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly kind: ArtifactKind;
  /** Null only for source-deleted tombstones. */
  readonly locator: ArtifactLocatorValue | null;
  readonly mediaType: string | null;
  readonly verification: EvidenceVerification;
  readonly sourceDeletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TraceEventView {
  readonly cursor: number;
  readonly id: string;
  readonly sessionId: string | null;
  readonly taskId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly attemptSequence: number;
  readonly kind: RunEventKind;
  readonly visibility: Exclude<TraceVisibility, "internal">;
  readonly redaction: Exclude<RedactionState, "omitted">;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly occurredAt: number;
}

export interface ParentNotificationView {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly createdAt: number;
}

/** What a retry tells the new attempt. The child's own transcript shows what already ran. */
export interface ResumeContext {
  readonly originalRequest: string;
  /** Tool calls the previous attempt started and never settled. */
  readonly uncertainToolCallIds: readonly string[];
}

/** Why a task's retry cannot start. */
export type ResumeBlocker =
  | "task_not_found"
  | "task_archived"
  | "task_deleted"
  | "attempt_alive"
  | "task_terminal"
  | "uncertain_side_effect"
  | "stale_attempt"
  | "origin_deleted"
  | "agent_deleted";

export type ResumeClaim = Data.TaggedEnum<{
  started: {
    readonly handle: AttemptHandle;
    readonly agentId: string;
    readonly context: ResumeContext;
  };
  blocked: { readonly reason: ResumeBlocker };
}>;
export const ResumeClaim = Data.taggedEnum<ResumeClaim>();

/** A user's retry: queued for the next parent run, or why it cannot be. */
export type ResumeRequest = Data.TaggedEnum<{
  queued: { readonly taskId: string; readonly expectedAttemptId: string };
  blocked: { readonly reason: ResumeBlocker };
}>;
export const ResumeRequest = Data.taggedEnum<ResumeRequest>();

/** Archiving one settled task directly, without a lifecycle operation. */
export type TaskArchive = Data.TaggedEnum<{
  archived: { readonly taskId: string };
  blocked: { readonly reason: "task_not_found" | "attempt_alive" | "task_not_archivable" };
}>;
export const TaskArchive = Data.taggedEnum<TaskArchive>();

export type LifecycleIntent = "archive" | "restore" | "delete";

/** A lifecycle operation as its row records it. */
export interface LifecycleOperationView {
  readonly operationId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly targetKind: "task" | "session";
  readonly targetId: string;
  readonly intent: LifecycleIntent;
  readonly blocker: string | null;
  readonly requestedAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

/** An operation still to finish. A new task operation names the child to stop first. */
type PendingOperation = LifecycleOperationView & {
  readonly agentId?: string | null;
  readonly activeAttemptId?: string | null;
};

/**
 * What asking for an archive, restore or delete gives: the recorded operation under its row's
 * status, or, when none was recorded, `completed` for a target already in the asked state and
 * `blocked` with why it cannot change.
 */
export type LifecycleRequest = Data.TaggedEnum<{
  requested: PendingOperation;
  cancelling: PendingOperation;
  waiting_for_stop: PendingOperation;
  purging: PendingOperation;
  failed: PendingOperation;
  completed: Omit<Partial<LifecycleOperationView>, "operationId"> & {
    readonly operationId?: string | null;
    readonly targetId: string;
    readonly intent: LifecycleIntent;
    readonly receiptId?: string | null;
  };
  blocked: Omit<Partial<LifecycleOperationView>, "operationId" | "blocker"> & {
    readonly blocker: string | null;
    readonly operationId?: string | null;
  };
}>;
export const LifecycleRequest = Data.taggedEnum<LifecycleRequest>();

/** Where finishing a lifecycle operation left it. */
export type LifecycleOutcome = Data.TaggedEnum<{
  completed: {
    readonly operationId: string;
    readonly targetId: string;
    readonly intent?: LifecycleIntent;
    readonly receiptId?: string | null;
  };
  /** A live attempt must stop first; finishing again completes it. */
  waiting_for_stop: { readonly operationId: string; readonly targetId: string };
  blocked: { readonly blocker: string; readonly operationId?: string };
}>;
export const LifecycleOutcome = Data.taggedEnum<LifecycleOutcome>();

export interface AttemptHandle {
  readonly id: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly chatRunId: string;
  readonly threadId: string;
  readonly attemptNumber: number;
}

export interface StartAttemptInput {
  readonly sessionId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly agentId: string | null;
  readonly agentName?: string;
  readonly title: string;
  readonly request: string;
  readonly kind: Exclude<InvocationKind, "steer">;
  readonly threadId: string;
  readonly resumedFromAttemptId?: string | null;
  readonly resumeReason?: string | null;
}

export interface AppendEventInput {
  readonly handle: AttemptHandle;
  readonly sessionId: string;
  readonly kind: RunEventKind;
  readonly summary: string;
  readonly visibility?: TraceVisibility;
  readonly redaction?: RedactionState;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly occurredAt?: number;
}

export interface RecordArtifactInput {
  readonly handle: AttemptHandle;
  readonly kind: ArtifactKind;
  readonly locator: ArtifactLocatorValue;
  readonly mediaType?: string | null;
  readonly verification?: Exclude<EvidenceVerification, "source_deleted">;
}

/** The status a task takes when its attempt reaches a status. */
const taskStatusForAttempt = {
  queued: "queued",
  running: "running",
  waiting: "waiting",
  blocked: "blocked",
  interrupted: "resumable",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<AttemptStatus, TaskStatus>;

/** What a heartbeat says once an attempt reaches a status by transition. */
const heartbeatStateForAttempt = {
  queued: "idle",
  running: "working",
  waiting: "waiting",
  blocked: "waiting",
  interrupted: "idle",
  completed: "idle",
  failed: "idle",
  cancelled: "idle",
} as const satisfies Record<AttemptStatus, HeartbeatState>;

/** The status an attempt's invocation takes when the attempt reaches a status. */
const invocationStatusForAttempt = {
  queued: "running",
  running: "running",
  waiting: "running",
  blocked: "running",
  interrupted: "failed",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies Record<AttemptStatus, string>;

/** What the parent hears when an attempt reaches a status; `resumed` only for a retry. */
const notificationForAttempt = {
  queued: null,
  running: "resumed",
  waiting: null,
  blocked: null,
  interrupted: "interrupted",
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
} as const satisfies Record<AttemptStatus, string | null>;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  /** The first row a query returns, if any. */
  const first = <A, E>(rows: Effect.Effect<ReadonlyArray<A>, E>) =>
    Effect.map(rows, (found) => found.at(0));
  /** What a write changed, as the connection reports it. */
  const run = <A>(statement: Statement.Statement<A>) =>
    Effect.flatMap(statement.raw, decodeRunResult);
  // A crash after prompt delivery but before parent completion must not lose operational
  // notifications. No current-process runs exist while this singleton is being constructed.
  yield* run(sql`UPDATE parent_notifications SET delivered_to_run_id = NULL, delivered_at = NULL
    WHERE delivered_to_run_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM chat_runs WHERE run_id = delivered_to_run_id AND status = 'completed')`);

  const assertHandle = Effect.fnUntraced(function* (handle: AttemptHandle) {
    const found = yield* first(sql`SELECT 1 FROM agent_run_attempts
      WHERE id = ${handle.id} AND task_id = ${handle.taskId} AND invocation_id = ${handle.invocationId}
        AND chat_run_id = ${handle.chatRunId} AND thread_id = ${handle.threadId}`);
    yield* Effect.when(
      Effect.fail(
        rejected("handle_mismatch", "Evidence AttemptHandle does not match a durable attempt"),
      ),
      Effect.succeed(!isTruthy(found)),
    );
  });
  const assertSafeFile = Effect.fnUntraced(function* (locator: {
    readonly path: string;
    readonly sha256: string;
  }) {
    if (
      locator.path.length === 0 ||
      locator.path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(locator.path) ||
      locator.path.split(/[\\/]/).includes("..")
    )
      return yield* rejected(
        "unsafe_file_path",
        "Evidence file paths must be project-relative and normalized",
      );
    yield* Effect.when(
      Effect.fail(
        rejected("missing_file_digest", "Evidence file locators require a sha256 digest"),
      ),
      Effect.succeed(!/^[a-f\d]{64}$/i.test(locator.sha256)),
    );
  });
  const handleOf = (attempt: typeof AttemptRow.Type): AttemptHandle => ({
    id: attempt.id,
    taskId: attempt.task_id,
    invocationId: attempt.invocation_id,
    chatRunId: attempt.chat_run_id,
    threadId: attempt.thread_id,
    attemptNumber: attempt.attempt_number,
  });
  const artifactView = Effect.fnUntraced(function* (row: typeof ArtifactRow.Type) {
    const view: TraceArtifactView = {
      id: row.id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      kind: row.kind,
      locator: row.locator === null ? null : yield* decodeArtifactLocator(row.locator),
      mediaType: row.media_type,
      verification: row.verification,
      sourceDeletedAt: row.source_deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return view;
  });
  const eventView = Effect.fnUntraced(function* (row: typeof StoredEventRow.Type) {
    const view: TraceEventView = {
      cursor: row.cursor,
      id: row.id,
      sessionId: row.origin_session_id,
      taskId: row.task_id,
      invocationId: row.invocation_id,
      attemptId: row.attempt_id,
      attemptSequence: row.attempt_sequence,
      kind: row.kind,
      visibility: row.visibility === "public" ? "public" : "summary",
      redaction: row.redaction === "redacted" ? "redacted" : "clear",
      summary: row.summary,
      payload: row.redaction === "redacted" ? {} : yield* decodePayload(row.payload),
      occurredAt: row.occurred_at,
    };
    return view;
  });
  const eventViews = (rows: ReadonlyArray<typeof StoredEventRow.Type>) =>
    Effect.forEach(rows, eventView);

  const recordArtifact = (input: RecordArtifactInput) =>
    Effect.gen(function* () {
      yield* assertHandle(input.handle);
      const locator = yield* Schema.decodeEffect(ArtifactLocator)(input.locator);
      yield* Effect.when(
        Effect.fail(rejected("artifact_kind_mismatch", "Artifact kind must match its locator")),
        Effect.succeed(!ArtifactLocator.guards[input.kind](locator)),
      );
      if (ArtifactLocator.guards.file(locator)) yield* assertSafeFile(locator);
      const encoded = yield* encodeArtifactLocator(locator);
      const existing = yield* first(sql`SELECT * FROM work_artifacts
        WHERE attempt_id = ${input.handle.id} AND kind = ${input.kind} AND locator = ${encoded}`);
      if (isTruthy(existing)) return yield* artifactView(yield* decodeArtifactRow(existing));
      const now = yield* Clock.currentTimeMillis;
      const inserted = yield* first(sql`INSERT INTO work_artifacts
        (id, task_id, attempt_id, kind, locator, media_type, verification, created_at, updated_at)
        VALUES (${yield* crypto.randomUUIDv4()}, ${input.handle.taskId}, ${input.handle.id},
          ${input.kind}, ${encoded}, ${input.mediaType ?? null},
          ${input.verification ?? "unverified"}, ${now}, ${now})
        RETURNING *`);
      return yield* artifactView(yield* decodeArtifactRow(inserted));
    }).pipe(sql.withTransaction);

  const setArtifactVerification = (
    artifactId: string,
    verification: Exclude<EvidenceVerification, "source_deleted">,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(sql`UPDATE work_artifacts SET verification = ${verification},
          source_deleted_at = NULL, updated_at = ${now}
        WHERE id = ${artifactId} AND locator IS NOT NULL RETURNING *`);
      return isTruthy(row) ? yield* artifactView(yield* decodeArtifactRow(row)) : null;
    }).pipe(sql.withTransaction);

  const markArtifactSourceDeleted = (artifactId: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const row = yield* first(sql`UPDATE work_artifacts
        SET locator = NULL, media_type = NULL, verification = 'source_deleted',
            source_deleted_at = ${now}, updated_at = ${now}
        WHERE id = ${artifactId} RETURNING *`);
      return isTruthy(row) ? yield* artifactView(yield* decodeArtifactRow(row)) : null;
    }).pipe(sql.withTransaction);

  /** Tool calls an attempt started and never settled. A retry must not repeat them unasked. */
  const pendingToolsOf = (attemptId: string) =>
    first(sql`SELECT pending_tool_call_ids FROM agent_run_attempts WHERE id = ${attemptId}`).pipe(
      Effect.flatMap(decodePendingTools),
      Effect.flatMap((row) => decodeStringArray(row.pending_tool_call_ids)),
    );
  const heartbeatView = (
    state: HeartbeatState | null,
    step: string | null,
    at: number | null,
  ): TraceHeartbeatView | null => (state === null || at === null ? null : { state, step, at });
  const failureOf = (failure: string | null) =>
    failure === null ? Effect.succeed(null) : decodeFailure(failure);
  /** Where an attempt was, read from its heartbeat, for a failure its caller cannot place. */
  const stageOf = Effect.fnUntraced(function* (attemptId: string) {
    const row = yield* first(sql`SELECT heartbeat_state, status, pending_tool_call_ids
      FROM agent_run_attempts WHERE id = ${attemptId}`);
    const live = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        heartbeat_state: Schema.NullOr(HeartbeatState),
        status: AttemptStatus,
        pending_tool_call_ids: Schema.String,
      }),
    )(row);
    const stage: AttemptFailureStage =
      live.status === "queued"
        ? "start"
        : (yield* decodeStringArray(live.pending_tool_call_ids)).length > 0
          ? "tool"
          : live.heartbeat_state === "waiting"
            ? "approval"
            : "model";
    return stage;
  });

  // Attempts the previous process left live failed with it. Retrying is the user's or the
  // parent's call, never automatic.
  const recoveredAttempts = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const attempts = yield* decodeRecoveryRows(
      yield* sql`SELECT a.id, a.task_id, t.project_id, t.origin_session_id, t.agent_id,
          t.parent_run_id
        FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
        WHERE a.status IN ('queued', 'running', 'waiting', 'blocked')`,
    );
    const failure: AttemptFailure = {
      reason: AttemptFailureReason.cases.ServerRestarted.make({}),
      stage: "restart",
    };
    const encodedFailure = yield* encodeFailure(failure);
    yield* Effect.forEach(
      attempts,
      (row) =>
        Effect.gen(function* () {
          const uncertain = (yield* pendingToolsOf(row.id)).length > 0;
          const retryable = row.origin_session_id !== null && row.agent_id !== null;
          yield* run(sql`UPDATE agent_run_attempts
            SET status = 'interrupted', resume_reason = 'server_restarted', failure = ${encodedFailure},
                heartbeat_state = 'idle', heartbeat_step = 'Stopped by a server restart',
                finished_at = ${now}, updated_at = ${now}
            WHERE id = ${row.id}`);
          yield* run(sql`UPDATE work_tasks
            SET status = ${!retryable ? "interrupted" : uncertain ? "blocked" : "resumable"},
                active_attempt_id = NULL, updated_at = ${now}
            WHERE id = ${row.task_id}`);
          const summary = !retryable
            ? "Execution was interrupted by a server restart."
            : uncertain
              ? "Subagent execution was interrupted by a server restart. A tool call may have run; check its effects before retrying."
              : "Subagent execution was interrupted by a server restart and can be retried.";
          yield* run(sql`INSERT INTO parent_notifications
            (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
             idempotency_key, created_at)
            VALUES (${yield* crypto.randomUUIDv4()}, ${row.project_id}, ${row.task_id},
              ${row.origin_session_id}, ${row.parent_run_id}, 'interrupted', ${summary},
              ${yield* encodeJson({ attemptId: row.id, failure })},
              ${`recovery:${row.id}:interrupted`}, ${now})
            ON CONFLICT(idempotency_key) DO NOTHING`);
        }),
      { discard: true },
    );
    return attempts.length;
  }).pipe(sql.withTransaction);

  const changes = yield* PubSub.unbounded<TraceChange>();
  const appendEvent = Effect.fnUntraced(function* (input: AppendEventInput) {
    const event = yield* Effect.gen(function* () {
      const next = yield* decodeSequence(
        yield* first(sql`SELECT coalesce(max(attempt_sequence), 0) + 1 AS sequence
          FROM run_events WHERE attempt_id = ${input.handle.id}`),
      );
      const occurredAt = input.occurredAt ?? (yield* Clock.currentTimeMillis);
      const id = yield* crypto.randomUUIDv4();
      const payload = yield* encodeJson(input.payload ?? {});
      const row = yield* decodeCursor(
        yield* first(sql`INSERT INTO run_events
          (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
           visibility, redaction, summary, payload, occurred_at)
          VALUES (${id}, ${input.sessionId}, ${input.handle.taskId}, ${input.handle.invocationId},
            ${input.handle.id}, ${next.sequence}, ${input.kind}, ${input.visibility ?? "summary"},
            ${input.redaction ?? "clear"}, ${input.summary}, ${payload}, ${occurredAt})
          RETURNING seq`),
      );
      return { id, cursor: row.seq, attemptSequence: next.sequence, occurredAt };
    }).pipe(sql.withTransaction);
    yield* PubSub.publish(changes, {
      kind: "event",
      sessionId: input.sessionId,
      cursor: event.cursor,
    });
    return event;
  });

  /** Wakes trace readers when a heartbeat says something new. Periodic beats alone do not. */
  const announceProgress = (sessionId: string) =>
    PubSub.publish(changes, { kind: "progress", sessionId });
  const liveStatuses = sql.literal("('queued', 'running', 'waiting', 'blocked')");

  /** Records what a live attempt is doing now. An attempt that already ended keeps its last beat. */
  const beat = (
    handle: AttemptHandle,
    sessionId: string,
    update: { readonly state: HeartbeatState; readonly step: string },
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      run(sql`UPDATE agent_run_attempts
      SET heartbeat_state = ${update.state}, heartbeat_step = ${update.step}, heartbeat_at = ${now}
      WHERE id = ${handle.id} AND status IN ${liveStatuses}`),
    ).pipe(
      Effect.flatMap((result) =>
        result.changes === 1 ? announceProgress(sessionId) : Effect.void,
      ),
    );

  /** A live attempt started a tool call; until it settles a retry treats it as possibly run. */
  const toolStarted = (
    handle: AttemptHandle,
    sessionId: string,
    toolCall: { readonly id: string; readonly name: string },
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      run(sql`UPDATE agent_run_attempts
      SET pending_tool_call_ids = json_insert(pending_tool_call_ids, '$[#]', ${toolCall.id}),
          heartbeat_state = 'working', heartbeat_step = ${`Running ${toolCall.name}`},
          heartbeat_at = ${now}
      WHERE id = ${handle.id} AND status IN ${liveStatuses}`),
    ).pipe(Effect.andThen(announceProgress(sessionId)));

  const toolSettled = (
    handle: AttemptHandle,
    sessionId: string,
    toolCall: { readonly id: string; readonly name: string },
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      run(sql`UPDATE agent_run_attempts
      SET pending_tool_call_ids = (SELECT json_group_array(value)
            FROM json_each(pending_tool_call_ids) WHERE value <> ${toolCall.id}),
          heartbeat_state = 'working', heartbeat_step = ${`Finished ${toolCall.name}`},
          heartbeat_at = ${now}
      WHERE id = ${handle.id} AND status IN ${liveStatuses}`),
    ).pipe(Effect.andThen(announceProgress(sessionId)));

  /**
   * Beats for a live attempt until interrupted. The owner forks it into the attempt's own scope,
   * so the beats stop exactly when the attempt's fiber does. A failed write is logged; missing
   * beats then let the watchdog judge the attempt lost.
   */
  const keepAlive = (handle: AttemptHandle) =>
    Effect.forever(
      Effect.sleep(heartbeatIntervalMs).pipe(
        // Each beat reads the clock; a statement built once would write its first time forever.
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) =>
          run(sql`UPDATE agent_run_attempts SET heartbeat_at = ${now}
            WHERE id = ${handle.id} AND status IN ${liveStatuses}`),
        ),
        Effect.catch(logFailure("work_trace_heartbeat_not_recorded")),
      ),
    );

  const notifyParent = (input: {
    readonly taskId: string;
    readonly kind:
      | "stopped"
      | "interrupted"
      | "archived"
      | "deleted"
      | "resume_blocked"
      | "resumed"
      | "completed"
      | "failed";
    readonly summary: string;
    readonly idempotencyKey: string;
    readonly payload?: Readonly<Record<string, JsonValue>>;
    readonly deliveredImmediately?: boolean;
    readonly deliveredToRunId?: string;
  }) =>
    Effect.gen(function* () {
      const task = yield* decodeNotificationTask(
        yield* first(sql`SELECT project_id, origin_session_id, parent_run_id FROM work_tasks
          WHERE id = ${input.taskId}`),
      );
      const now = yield* Clock.currentTimeMillis;
      const id = yield* crypto.randomUUIDv4();
      const payload = yield* encodeJson(input.payload ?? {});
      const deliveredToRunId =
        input.deliveredImmediately === true ? (input.deliveredToRunId ?? task.parent_run_id) : null;
      const result = yield* run(sql`INSERT INTO parent_notifications
        (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
         idempotency_key, delivered_to_run_id, delivered_at, created_at)
        VALUES (${id}, ${task.project_id}, ${input.taskId}, ${task.origin_session_id},
          ${task.parent_run_id}, ${input.kind}, ${input.summary}, ${payload},
          ${input.idempotencyKey}, ${deliveredToRunId},
          ${input.deliveredImmediately === true ? now : null}, ${now})
        ON CONFLICT(idempotency_key) DO NOTHING`);
      return result.changes === 1 ? id : null;
    }).pipe(sql.withTransaction);

  const releaseParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    Effect.map(
      run(sql`UPDATE parent_notifications SET delivered_to_run_id = NULL, delivered_at = NULL
        WHERE origin_session_id = ${sessionId} AND delivered_to_run_id = ${deliveredToRunId}`),
      (result) => result.changes,
    );

  const consumeParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    Effect.gen(function* () {
      const rows = yield* decodeParentNotificationRows(
        yield* sql`SELECT id, task_id, kind, summary, payload, created_at
          FROM parent_notifications
          WHERE origin_session_id = ${sessionId} AND delivered_at IS NULL ORDER BY seq`,
      );
      const now = yield* Clock.currentTimeMillis;
      const claimed = yield* Effect.filter(rows, (row) =>
        Effect.map(
          run(sql`UPDATE parent_notifications
            SET delivered_to_run_id = ${deliveredToRunId}, delivered_at = ${now}
            WHERE id = ${row.id} AND delivered_at IS NULL`),
          (result) => result.changes === 1,
        ),
      );
      return yield* Effect.forEach(claimed, (row) =>
        Effect.map(decodePayload(row.payload), (payload): ParentNotificationView => ({
          id: row.id,
          taskId: row.task_id,
          kind: row.kind,
          summary: row.summary,
          payload,
          createdAt: row.created_at,
        })),
      );
    }).pipe(sql.withTransaction);

  const startAttempt = (input: StartAttemptInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const taskId = yield* crypto.randomUUIDv4();
      const invocationId = yield* crypto.randomUUIDv4();
      const attemptId = yield* crypto.randomUUIDv4();
      const chatRunId = yield* crypto.randomUUIDv4();
      const previousAttempt = isTruthy(input.resumedFromAttemptId)
        ? yield* first(sql`SELECT attempt_number FROM agent_run_attempts
            WHERE id = ${input.resumedFromAttemptId}`)
        : undefined;
      const attemptNumber = isTruthy(previousAttempt)
        ? (yield* decodeAttemptNumber(previousAttempt)).attempt_number + 1
        : 1;
      const agentId = input.agentId;
      const insertedTask = yield* run(sql`INSERT INTO work_tasks
        (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_id,
         agent_name, status, title, request, active_attempt_id, created_at, updated_at)
        SELECT ${taskId}, s.project_id, s.id, ${input.parentRunId}, ${input.parentToolCallId}, a.id,
          coalesce(a.name, ${input.agentName ?? null}, 'subagent'),
          'queued', ${input.title}, ${input.request}, NULL, ${now}, ${now}
        FROM sessions s LEFT JOIN subagents a ON a.session_id = s.id AND a.id = ${agentId}
        WHERE s.id = ${input.sessionId} AND (${agentId} IS NULL OR a.id IS NOT NULL)`);
      yield* Effect.when(
        Effect.fail(
          rejected("origin_missing", "Work Trace origin session or subagent no longer exists"),
        ),
        Effect.succeed(insertedTask.changes !== 1),
      );
      const idempotencyKey = `${input.parentRunId}:${input.parentToolCallId}`;
      yield* run(sql`INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
         target_attempt_id, idempotency_key, created_at)
        VALUES (${invocationId}, ${taskId}, ${input.parentRunId}, ${input.parentToolCallId},
          ${input.kind}, 'accepted', ${input.request}, ${input.resumedFromAttemptId ?? null},
          ${idempotencyKey}, ${now})`);
      yield* run(sql`INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
         resumed_from_attempt_id, resume_reason, heartbeat_state, heartbeat_step, heartbeat_at,
         created_at, updated_at)
        VALUES (${attemptId}, ${taskId}, ${invocationId}, ${attemptNumber}, ${chatRunId},
          ${input.threadId}, 'queued', ${input.resumedFromAttemptId ?? null},
          ${input.resumeReason ?? null}, 'idle', 'Queued', ${now}, ${now}, ${now})`);
      yield* run(sql`UPDATE work_tasks SET active_attempt_id = ${attemptId} WHERE id = ${taskId}`);
      const handle: AttemptHandle = {
        id: attemptId,
        taskId,
        invocationId,
        chatRunId,
        threadId: input.threadId,
        attemptNumber,
      };
      yield* appendEvent({
        handle,
        sessionId: input.sessionId,
        kind: input.kind === "resume" ? "resume_requested" : "attempt_queued",
        summary: input.kind === "resume" ? "Resume requested" : "Task queued",
        occurredAt: now,
      });
      return handle;
    }).pipe(sql.withTransaction);

  const recordSteer = (input: {
    readonly handle: AttemptHandle;
    readonly sessionId: string;
    readonly parentRunId: string;
    readonly parentToolCallId: string;
    readonly message: string;
  }) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4();
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
         target_attempt_id, idempotency_key, created_at, finished_at)
        VALUES (${id}, ${input.handle.taskId}, ${input.parentRunId}, ${input.parentToolCallId},
          'steer', 'steered', ${input.message}, ${input.handle.id},
          ${`${input.parentRunId}:${input.parentToolCallId}`}, ${now}, ${now})`);
      yield* appendEvent({
        handle: { ...input.handle, invocationId: id },
        sessionId: input.sessionId,
        kind: "steered",
        summary: "Additional instructions delivered",
        occurredAt: now,
      });
      return id;
    }).pipe(sql.withTransaction);

  const transitionAttempt = (
    handle: AttemptHandle,
    sessionId: string,
    status: AttemptStatus,
    event: RunEventKind,
    summary: string,
    failure?: {
      readonly reason: AttemptFailureReason;
      readonly stage?: AttemptFailureStage;
    } | null,
    deliveredImmediately = true,
    deliveredToRunId?: string,
    detail: Readonly<Record<string, JsonValue>> = {},
  ) =>
    Effect.gen(function* () {
      const current = yield* decodeAttempt(
        yield* first(sql`SELECT * FROM agent_run_attempts WHERE id = ${handle.id}`),
      );
      const from = current.status;
      yield* Effect.when(
        Effect.fail(
          rejected("invalid_transition", `Invalid attempt transition ${from} -> ${status}`),
        ),
        Effect.succeed(!canTransitionAttempt(from, status)),
      );
      const now = yield* Clock.currentTimeMillis;
      const terminal = ["interrupted", "completed", "failed", "cancelled"].includes(status);
      const recorded: AttemptFailure | null = isTruthy(failure)
        ? { reason: failure.reason, stage: failure.stage ?? (yield* stageOf(handle.id)) }
        : null;
      yield* run(sql`UPDATE agent_run_attempts
        SET status = ${status}, started_at = coalesce(started_at, ${now}),
            finished_at = ${terminal ? now : null}, updated_at = ${now},
            failure = ${recorded === null ? null : yield* encodeFailure(recorded)},
            heartbeat_state = ${heartbeatStateForAttempt[status]}, heartbeat_step = ${summary},
            heartbeat_at = ${now}
        WHERE id = ${handle.id}`);
      yield* run(sql`UPDATE work_tasks SET status = ${taskStatusForAttempt[status]},
          active_attempt_id = ${terminal ? null : handle.id}, updated_at = ${now}
        WHERE id = ${handle.taskId}`);
      yield* run(sql`UPDATE agent_invocations SET status = ${invocationStatusForAttempt[status]},
          finished_at = ${terminal ? now : null}
        WHERE id = ${handle.invocationId}`);
      const appended = yield* appendEvent({
        handle,
        sessionId,
        kind: event,
        summary,
        payload: recorded === null ? detail : { ...detail, failure: recorded },
        occurredAt: now,
      });
      const notificationKind = Option.filter(
        Option.fromNullishOr(notificationForAttempt[status]),
        (kind) => kind !== "resumed" || handle.attemptNumber > 1,
      );
      yield* Option.match(notificationKind, {
        onNone: () => Effect.void,
        onSome: (kind) =>
          notifyParent({
            taskId: handle.taskId,
            kind,
            summary,
            idempotencyKey: `attempt:${handle.id}:${kind}`,
            payload:
              recorded === null
                ? { attemptId: handle.id }
                : { attemptId: handle.id, failure: recorded },
            deliveredImmediately,
            ...optionalProperty("deliveredToRunId", deliveredToRunId),
          }),
      });
      return appended;
    }).pipe(sql.withTransaction);

  const artifactsForTask = (taskId: string) =>
    sql`SELECT * FROM work_artifacts WHERE task_id = ${taskId} ORDER BY created_at, id`.pipe(
      Effect.flatMap(decodeArtifactRows),
      Effect.flatMap((rows) => Effect.forEach(rows, artifactView)),
    );

  const answerClaimsForTask = Effect.fnUntraced(function* (taskId: string) {
    const claims = yield* decodeFinalAnswerClaimRows(
      yield* sql`SELECT DISTINCT c.id, c.project_id, c.origin_session_id, c.parent_run_id,
          c.parent_message_id, c.created_at
        FROM final_answer_claims c
        WHERE EXISTS (SELECT 1 FROM final_answer_sources s
                      WHERE s.claim_id = c.id AND s.task_id = ${taskId})
           OR EXISTS (SELECT 1 FROM final_answer_notifications n
                      WHERE n.claim_id = c.id AND n.task_id = ${taskId})
        ORDER BY c.created_at, c.id`,
    );
    return yield* Effect.forEach(claims, (claim) =>
      Effect.gen(function* () {
        const sources = yield* decodeFinalAnswerSourceRows(
          yield* sql`SELECT id, claim_id, task_id, attempt_id
            FROM final_answer_sources WHERE claim_id = ${claim.id}
            ORDER BY task_id, attempt_id`,
        );
        const notifications = yield* decodeFinalAnswerNotificationRows(
          yield* sql`SELECT claim_id, notification_id, task_id FROM final_answer_notifications
            WHERE claim_id = ${claim.id} ORDER BY notification_id`,
        );
        const view: TraceFinalAnswerClaimView = {
          id: claim.id,
          projectId: claim.project_id,
          originSessionId: claim.origin_session_id,
          parentRunId: claim.parent_run_id,
          parentMessageId: claim.parent_message_id,
          sources: sources.map((source) => ({
            taskId: source.task_id,
            attemptId: source.attempt_id,
          })),
          notificationIds: notifications.map((notification) => notification.notification_id),
          createdAt: claim.created_at,
        };
        return view;
      }),
    );
  });

  /**
   * Records which subagent reports and status notifications an answer used. The caller checks
   * that each report was reviewed in its run; the store checks that each belongs to the session.
   */
  const finalizeAnswerClaim = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly parentRunId: string;
    readonly parentMessageId: string;
    readonly usedReports: readonly { readonly taskId: string; readonly attemptId: string }[];
    readonly reflectedNotificationIds: readonly string[];
  }) =>
    Effect.gen(function* () {
      const existing = yield* first(sql`SELECT id FROM final_answer_claims
        WHERE parent_run_id = ${input.parentRunId} AND parent_message_id = ${input.parentMessageId}`);
      if (isTruthy(existing)) return (yield* decodeId(existing)).id;
      const session = yield* first(sql`SELECT 1 FROM sessions
        WHERE id = ${input.sessionId} AND project_id = ${input.projectId}`);
      yield* Effect.when(
        Effect.fail(
          rejected("foreign_session", "Final answer session does not belong to the project"),
        ),
        Effect.succeed(!isTruthy(session)),
      );
      const reports = EffectArray.dedupeWith(
        input.usedReports,
        (a, b) => a.taskId === b.taskId && a.attemptId === b.attemptId,
      );
      yield* Effect.forEach(
        reports,
        (report) =>
          Effect.flatMap(
            first(sql`SELECT 1 FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
              WHERE a.id = ${report.attemptId} AND a.task_id = ${report.taskId}
                AND t.project_id = ${input.projectId} AND t.origin_session_id = ${input.sessionId}`),
            (found) =>
              Effect.when(
                Effect.fail(
                  rejected("foreign_report", "Final answer selected another session's report"),
                ),
                Effect.succeed(!isTruthy(found)),
              ),
          ),
        { discard: true },
      );
      // A notification listed twice is recorded once.
      const notificationTasks = MutableHashMap.fromIterable(
        yield* Effect.forEach(input.reflectedNotificationIds, (notificationId) =>
          first(sql`SELECT n.task_id FROM parent_notifications n
            JOIN work_tasks t ON t.id = n.task_id
            WHERE n.id = ${notificationId} AND n.origin_session_id = ${input.sessionId}
              AND n.delivered_to_run_id = ${input.parentRunId} AND t.project_id = ${input.projectId}`).pipe(
            Effect.flatMap((row) =>
              Effect.fromOption(Option.fromUndefinedOr(row), () =>
                rejected(
                  "undelivered_notification",
                  "Final answer selected an undelivered parent notification",
                ),
              ),
            ),
            Effect.flatMap(decodeTaskId),
            Effect.map(({ task_id }) => [notificationId, task_id] as const),
          ),
        ),
      );
      const claimId = yield* crypto.randomUUIDv4();
      const claimedAt = yield* Clock.currentTimeMillis;
      yield* run(sql`INSERT INTO final_answer_claims
        (id, project_id, origin_session_id, parent_run_id, parent_message_id, created_at)
        VALUES (${claimId}, ${input.projectId}, ${input.sessionId}, ${input.parentRunId},
          ${input.parentMessageId}, ${claimedAt})`);
      yield* Effect.forEach(
        reports,
        (report) =>
          Effect.flatMap(crypto.randomUUIDv4(), (id) =>
            run(sql`INSERT INTO final_answer_sources (id, claim_id, task_id, attempt_id)
              VALUES (${id}, ${claimId}, ${report.taskId}, ${report.attemptId})`),
          ),
        { discard: true },
      );
      yield* Effect.forEach(
        notificationTasks,
        ([id, taskId]) =>
          run(sql`INSERT INTO final_answer_notifications (claim_id, notification_id, task_id)
            VALUES (${claimId}, ${id}, ${taskId})`),
        { discard: true },
      );
      return claimId;
    }).pipe(sql.withTransaction);

  const taskView = Effect.fnUntraced(function* (row: typeof TaskViewRow.Type) {
    const view: TraceTaskView = {
      id: row.id,
      projectId: row.project_id,
      originSessionId: row.origin_session_id,
      parentTaskId: row.parent_task_id,
      parentRunId: row.parent_run_id,
      parentToolCallId: row.parent_tool_call_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status,
      title: row.title,
      request: row.request,
      activeAttemptId: row.active_attempt_id,
      latestAttemptId: row.latest_attempt_id,
      latestAttemptStatus: row.latest_attempt_status,
      latestAttemptNumber: row.latest_attempt_number,
      latestResumedFromAttemptId: row.latest_resumed_from_attempt_id,
      heartbeat: heartbeatView(row.heartbeat_state, row.heartbeat_step, row.heartbeat_at),
      latestFailure: yield* failureOf(row.latest_failure),
      archivedAt: row.archived_at,
      deleteRequestedAt: row.delete_requested_at,
      deletedAt: row.deleted_at,
      purgeReceiptId: row.purge_receipt_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return view;
  });
  const taskViews = (rows: ReadonlyArray<typeof TaskViewRow.Type>) =>
    Effect.forEach(rows, taskView);

  const taskTree = (sessionId: string) =>
    sql`SELECT t.id, t.project_id, t.origin_session_id, t.parent_task_id,
        t.parent_run_id, t.parent_tool_call_id, t.agent_id, t.agent_name,
        CASE
          WHEN t.deleted_at IS NOT NULL THEN 'deleted'
          WHEN t.archived_at IS NOT NULL THEN 'archived'
          ELSE t.status
        END AS status,
        t.title, t.request,
        t.active_attempt_id, a.id AS latest_attempt_id,
        a.status AS latest_attempt_status, a.attempt_number AS latest_attempt_number,
        a.resumed_from_attempt_id AS latest_resumed_from_attempt_id,
        a.heartbeat_state, a.heartbeat_step, a.heartbeat_at, a.failure AS latest_failure,
        t.archived_at, t.delete_requested_at, t.deleted_at, t.purge_receipt_id,
        t.updated_at, t.created_at
      FROM work_tasks t
      LEFT JOIN agent_run_attempts a ON a.id =
        (SELECT latest.id FROM agent_run_attempts latest
         WHERE latest.task_id = t.id ORDER BY latest.attempt_number DESC LIMIT 1)
      WHERE t.origin_session_id = ${sessionId} ORDER BY t.created_at, t.id`.pipe(
      Effect.flatMap(decodeTaskViewRows),
      Effect.flatMap(taskViews),
    );

  /** Project-owned review projection, including tasks whose origin session was deleted. */
  const projectTaskTree = (projectId: string) =>
    sql`SELECT t.id, t.project_id, t.origin_session_id, t.parent_task_id,
        t.parent_run_id, t.parent_tool_call_id, t.agent_id, t.agent_name,
        CASE
          WHEN t.deleted_at IS NOT NULL THEN 'deleted'
          WHEN t.archived_at IS NOT NULL THEN 'archived'
          ELSE t.status
        END AS status,
        t.title, t.request,
        t.active_attempt_id, a.id AS latest_attempt_id,
        a.status AS latest_attempt_status, a.attempt_number AS latest_attempt_number,
        a.resumed_from_attempt_id AS latest_resumed_from_attempt_id,
        a.heartbeat_state, a.heartbeat_step, a.heartbeat_at, a.failure AS latest_failure,
        t.archived_at, t.delete_requested_at, t.deleted_at, t.purge_receipt_id,
        t.updated_at, t.created_at
      FROM work_tasks t
      LEFT JOIN agent_run_attempts a ON a.id =
        (SELECT latest.id FROM agent_run_attempts latest
         WHERE latest.task_id = t.id ORDER BY latest.attempt_number DESC LIMIT 1)
      WHERE t.project_id = ${projectId} ORDER BY t.created_at, t.id`.pipe(
      Effect.flatMap(decodeTaskViewRows),
      Effect.flatMap(taskViews),
    );

  const attemptsForTask = Effect.fnUntraced(function* (taskId: string) {
    const rows = yield* decodeAttemptViewRows(
      yield* sql`SELECT id, invocation_id, attempt_number, chat_run_id, thread_id, status,
          resumed_from_attempt_id, superseded_by_attempt_id, heartbeat_state, heartbeat_step,
          heartbeat_at, pending_tool_call_ids, failure,
          started_at, finished_at, created_at, updated_at
        FROM agent_run_attempts WHERE task_id = ${taskId} ORDER BY attempt_number`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const view: TraceAttemptView = {
          id: row.id,
          invocationId: row.invocation_id,
          attemptNumber: row.attempt_number,
          chatRunId: row.chat_run_id,
          threadId: row.thread_id,
          status: row.status,
          resumedFromAttemptId: row.resumed_from_attempt_id,
          supersededByAttemptId: row.superseded_by_attempt_id,
          heartbeat: heartbeatView(row.heartbeat_state, row.heartbeat_step, row.heartbeat_at),
          pendingToolCallIds: yield* decodeStringArray(row.pending_tool_call_ids),
          failure: yield* failureOf(row.failure),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        return view;
      }),
    );
  });

  const detailOf = Effect.fnUntraced(function* <E>(
    task: TraceTaskView,
    events: Effect.Effect<ReadonlyArray<TraceEventView>, E>,
  ) {
    return {
      task,
      attempts: yield* attemptsForTask(task.id),
      artifacts: yield* artifactsForTask(task.id),
      answerClaims: yield* answerClaimsForTask(task.id),
      events: yield* events,
    };
  });

  const taskDetail = Effect.fnUntraced(function* (sessionId: string, taskId: string) {
    const task = (yield* taskTree(sessionId)).find((candidate) => candidate.id === taskId);
    if (!isTruthy(task)) return null;
    return yield* detailOf(
      task,
      Effect.map(events(sessionId, 0, 500), (found) =>
        found.filter((event) => event.taskId === taskId),
      ),
    );
  });

  const projectTaskDetail = Effect.fnUntraced(function* (projectId: string, taskId: string) {
    const task = (yield* projectTaskTree(projectId)).find((candidate) => candidate.id === taskId);
    if (!isTruthy(task)) return null;
    if (task.originSessionId !== null) return yield* taskDetail(task.originSessionId, taskId);
    return yield* detailOf(
      task,
      sql`SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
          attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
        FROM run_events WHERE task_id = ${taskId}
          AND visibility <> 'internal' AND redaction <> 'omitted'
        ORDER BY seq LIMIT 500`.pipe(
        Effect.flatMap(decodeStoredEventRows),
        Effect.flatMap(eventViews),
      ),
    );
  });

  const resumeBlocked = (reason: ResumeBlocker): ResumeClaim => ResumeClaim.blocked({ reason });

  const claimResume = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly expectedAttemptId: string;
    readonly parentRunId: string;
    readonly parentToolCallId: string;
    readonly confirmUncertain: boolean;
  }) =>
    Effect.gen(function* () {
      const candidate = yield* first(sql`SELECT t.id, t.origin_session_id, t.agent_id, t.request,
          t.status, t.active_attempt_id, t.archived_at, t.delete_requested_at, t.deleted_at,
          a.id AS previous_attempt_id, a.attempt_number AS previous_attempt_number,
          a.status AS previous_status, a.thread_id
        FROM work_tasks t
        JOIN agent_run_attempts a ON a.task_id = t.id
        WHERE t.id = ${input.taskId} AND t.origin_session_id = ${input.sessionId}
        ORDER BY a.attempt_number DESC LIMIT 1`);
      if (!isTruthy(candidate)) return resumeBlocked("task_not_found");
      const task = yield* decodeResumeTask(candidate);
      if (task.deleted_at !== null || task.delete_requested_at !== null)
        return resumeBlocked("task_deleted");
      if (task.archived_at !== null) return resumeBlocked("task_archived");
      if (task.origin_session_id === null) return resumeBlocked("origin_deleted");
      if (task.agent_id === null) return resumeBlocked("agent_deleted");
      if (isTruthy(task.active_attempt_id)) return resumeBlocked("attempt_alive");
      if (task.status === "completed") return resumeBlocked("task_terminal");
      if (task.previous_attempt_id !== input.expectedAttemptId)
        return resumeBlocked("stale_attempt");
      const uncertain = yield* pendingToolsOf(task.previous_attempt_id);
      if (uncertain.length > 0 && !input.confirmUncertain)
        return resumeBlocked("uncertain_side_effect");

      const now = yield* Clock.currentTimeMillis;
      const invocationId = yield* crypto.randomUUIDv4();
      const attemptId = yield* crypto.randomUUIDv4();
      const chatRunId = yield* crypto.randomUUIDv4();
      const attemptNumber = task.previous_attempt_number + 1;
      const resumeReason =
        task.previous_status === "interrupted" ? "server_restarted" : "provider_failed";
      yield* run(sql`INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
         target_attempt_id, idempotency_key, created_at)
        VALUES (${invocationId}, ${task.id}, ${input.parentRunId}, ${input.parentToolCallId},
          'resume', 'accepted', ${task.request}, ${task.previous_attempt_id},
          ${`${input.parentRunId}:${input.parentToolCallId}`}, ${now})`);
      yield* run(sql`INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
         resumed_from_attempt_id, resume_reason, heartbeat_state, heartbeat_step, heartbeat_at,
         created_at, updated_at)
        VALUES (${attemptId}, ${task.id}, ${invocationId}, ${attemptNumber}, ${chatRunId},
          ${task.thread_id}, 'queued', ${task.previous_attempt_id}, ${resumeReason}, 'idle',
          'Queued for retry', ${now}, ${now}, ${now})`);
      yield* run(sql`UPDATE agent_run_attempts SET superseded_by_attempt_id = ${attemptId},
          updated_at = ${now}
        WHERE id = ${task.previous_attempt_id}`);
      yield* run(sql`UPDATE work_tasks SET status = 'resuming', active_attempt_id = ${attemptId},
          retry_requested_at = NULL, retry_confirm_uncertain = 0, updated_at = ${now}
        WHERE id = ${task.id}`);
      const handle: AttemptHandle = {
        id: attemptId,
        taskId: task.id,
        invocationId,
        chatRunId,
        threadId: task.thread_id,
        attemptNumber,
      };
      yield* appendEvent({
        handle,
        sessionId: input.sessionId,
        kind: "resume_requested",
        summary: "Retry requested",
        occurredAt: now,
      });
      return ResumeClaim.started({
        handle,
        agentId: task.agent_id,
        context: { originalRequest: task.request, uncertainToolCallIds: uncertain },
      });
    }).pipe(sql.withTransaction);

  /** A retried request answers with the operation it recorded, under that row's status. */
  const lifecycleOperationView = (row: typeof LifecycleOperationRow.Type): LifecycleRequest =>
    LifecycleRequest[row.status]({
      operationId: row.id,
      projectId: row.project_id,
      sessionId: row.origin_session_id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      intent: row.intent,
      blocker: row.blocker,
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    });

  /**
   * Whether a running board of another conversation's Goal waits for one of this conversation's
   * Goals to merge. Deleting this conversation would end that wait without the merge.
   */
  const goalDependents = (sessionId: string) =>
    Effect.map(
      first(sql`SELECT 1 AS found FROM kanban_goal_dependencies d
        JOIN workflow_goal_instances g ON g.goal_instance_id = d.depends_on
        JOIN kanban_goals k ON k.goal_instance_id = d.goal_instance_id
        WHERE g.session_id = ${sessionId} AND k.session_id <> ${sessionId} AND k.status = 'active'
        LIMIT 1`),
      isTruthy,
    );

  const requestSessionLifecycle = (input: {
    readonly sessionId: string;
    readonly intent: LifecycleIntent;
    readonly idempotencyKey: string;
  }) =>
    Effect.gen(function* () {
      const retried = yield* first(sql`SELECT * FROM lifecycle_operations
        WHERE idempotency_key = ${input.idempotencyKey}`);
      if (isTruthy(retried))
        return lifecycleOperationView(yield* decodeLifecycleOperation(retried));
      const session = yield* decodeSessionLifecycle(
        yield* first(
          sql`SELECT project_id, archived_at FROM sessions WHERE id = ${input.sessionId}`,
        ),
      );
      if (session === undefined) return LifecycleRequest.blocked({ blocker: "session_not_found" });
      // Refused before anything stops or any task is deleted.
      if (input.intent === "delete" && (yield* goalDependents(input.sessionId)))
        return LifecycleRequest.blocked({ blocker: "goal_dependents" });
      if (input.intent === "restore" && session.archived_at === null)
        return LifecycleRequest.blocked({ blocker: "session_not_archived" });
      if (input.intent === "archive" && session.archived_at !== null)
        return LifecycleRequest.completed({ targetId: input.sessionId, intent: input.intent });
      const now = yield* Clock.currentTimeMillis;
      const operationId = yield* crypto.randomUUIDv4();
      yield* run(sql`INSERT INTO lifecycle_operations
        (id, project_id, origin_session_id, target_kind, target_id, intent, status,
         idempotency_key, requested_at, updated_at)
        VALUES (${operationId}, ${session.project_id}, ${input.sessionId}, 'session',
          ${input.sessionId}, ${input.intent}, 'cancelling', ${input.idempotencyKey}, ${now}, ${now})`);
      return LifecycleRequest.cancelling({
        operationId,
        projectId: session.project_id,
        sessionId: input.sessionId,
        targetKind: "session",
        targetId: input.sessionId,
        intent: input.intent,
        blocker: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: null,
      });
    }).pipe(sql.withTransaction);

  /**
   * Deletes the Goal history of a conversation being deleted: owner receipts, run bindings, the Goal
   * catalog, and what its boards and durable executions kept. Its permit lets only this
   * transaction delete the rows that stay immutable otherwise. Gives how many Goals went.
   */
  const purgeGoalHistory = Effect.fnUntraced(function* (sessionId: string) {
    const goals = sql`SELECT goal_instance_id FROM workflow_goal_instances
      WHERE session_id = ${sessionId}`;
    const executions = sql`SELECT execution_id FROM owner_workflow_executions
      WHERE coalesce(json_extract(payload_json, '$.sessionId'),
        json_extract(payload_json, '$.identity.sessionId')) = ${sessionId}`;
    yield* run(sql`INSERT INTO goal_history_purges (session_id) VALUES (${sessionId})`);
    yield* run(sql`DELETE FROM owner_read_recoveries WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM owner_rpc_operations WHERE run_id IN
      (SELECT run_id FROM workflow_run_bindings WHERE session_id = ${sessionId})`);
    yield* run(sql`DELETE FROM workflow_new_goal_requests WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM workflow_run_bindings WHERE session_id = ${sessionId}`);
    yield* run(
      sql`DELETE FROM workflow_goal_worker_generations WHERE goal_instance_id IN (${goals})`,
    );
    yield* run(
      sql`DELETE FROM workflow_goal_native_artifacts WHERE goal_instance_id IN (${goals})`,
    );
    yield* run(sql`DELETE FROM kanban_cards WHERE goal_instance_id IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_card_attempts WHERE goal_instance_id IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_card_runs WHERE goal_instance_id IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_decision_followups WHERE goal_instance_id IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_goal_schedules WHERE goal_instance_id IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_goal_dependencies
      WHERE goal_instance_id IN (${goals}) OR depends_on IN (${goals})`);
    yield* run(sql`DELETE FROM kanban_goal_ranks WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM persisted_queue_items WHERE CASE WHEN json_valid(element_json)
      THEN json_extract(element_json, '$.payload.sessionId') END = ${sessionId}`);
    yield* run(sql`DELETE FROM human_decision_closures WHERE execution_id IN (${executions})`);
    yield* run(sql`DELETE FROM owner_workflow_executions WHERE execution_id IN (${executions})`);
    const purged = (yield* run(sql`DELETE FROM workflow_goal_instances
      WHERE session_id = ${sessionId}`)).changes;
    yield* run(sql`DELETE FROM goal_history_purges WHERE session_id = ${sessionId}`);
    return purged;
  });

  const purgeSession = Effect.fnUntraced(function* (
    operation: typeof LifecycleOperationRow.Type,
    now: number,
  ) {
    const sessionId = operation.target_id;
    const subagentRows = yield* decodeIds(
      yield* sql`SELECT id FROM subagents WHERE session_id = ${sessionId}`,
    );
    // One statement per table over all of the session's nodes: a statement per node kept the write
    // lock for minutes on a long conversation.
    const ids = sql`SELECT id FROM nodes WHERE session_id = ${sessionId}`;
    const seqs = sql`SELECT seq FROM nodes WHERE session_id = ${sessionId}`;
    yield* run(sql`INSERT INTO nodes_fts(nodes_fts, rowid, text)
      SELECT 'delete', seq, text FROM nodes WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM interpretations WHERE node_id IN (${ids}) OR target_id IN (${ids})`);
    yield* run(sql`DELETE FROM edges WHERE from_id IN (${ids}) OR to_id IN (${ids})`);
    yield* run(sql`DELETE FROM node_refs WHERE node_id IN (${ids})`);
    yield* run(sql`DELETE FROM node_attachments WHERE node_id IN (${ids})`);
    yield* run(sql`DELETE FROM imported_nodes WHERE node_id IN (${ids})`);
    yield* run(sql`DELETE FROM interpret_jobs WHERE node_id IN (${ids})`);
    yield* run(sql`DELETE FROM node_vectors WHERE node_seq IN (${seqs})`);
    yield* run(sql`DELETE FROM node_morphs WHERE node_seq IN (${seqs})`);
    yield* run(sql`DELETE FROM nodes_morph WHERE rowid IN (${seqs})`);
    yield* run(sql`DELETE FROM memory_graph_suppressed_nodes WHERE node_seq IN (${seqs})`);
    const nodes = (yield* run(sql`DELETE FROM nodes WHERE session_id = ${sessionId}`)).changes;
    yield* run(sql`DELETE FROM chat_metadata WHERE namespace = 'background-task-result'
      AND key IN (SELECT id FROM work_tasks WHERE origin_session_id = ${sessionId})`);
    const threadIds = [sessionId, ...subagentRows.map((row) => `subagent-${row.id}`)];
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const chatRuns = yield* decodeRunIds(
            yield* sql`SELECT run_id FROM chat_runs WHERE thread_id = ${threadId}`,
          );
          yield* Effect.forEach(
            chatRuns,
            (chatRun) => run(sql`DELETE FROM chat_interrupts WHERE run_id = ${chatRun.run_id}`),
            { discard: true },
          );
          yield* run(sql`DELETE FROM chat_interrupts WHERE thread_id = ${threadId}`);
          yield* run(sql`DELETE FROM chat_runs WHERE thread_id = ${threadId}`);
          yield* run(sql`DELETE FROM chat_threads WHERE thread_id = ${threadId}`);
        }),
      { discard: true },
    );
    yield* run(sql`DELETE FROM permission_reviews WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM queued_messages WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM imported_sessions WHERE session_id = ${sessionId}`);
    const goals = yield* purgeGoalHistory(sessionId);
    yield* run(sql`DELETE FROM session_workflows WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM subagents WHERE session_id = ${sessionId}`);
    yield* run(sql`DELETE FROM sessions WHERE id = ${sessionId}`);
    const purgedCounts = yield* encodeJson({ nodes, subagents: subagentRows.length, goals });
    const retainedKinds = yield* encodeJson([
      "task_tombstones",
      "answer_claims",
      "adopted_memory",
      "purge_receipts",
    ]);
    yield* run(sql`INSERT INTO purge_receipts
      (id, operation_id, project_id, target_kind, target_id, policy_version,
       purged_counts, retained_kinds, completed_at)
      VALUES (${yield* crypto.randomUUIDv4()}, ${operation.id}, ${operation.project_id}, 'session',
        ${sessionId}, 1, ${purgedCounts}, ${retainedKinds}, ${now})`);
  });

  /**
   * Purges a conversation being deleted, unless something keeps it: then the operation records
   * that blocker and stays unfinished.
   */
  const deleteSession = Effect.fnUntraced(function* (
    operation: typeof LifecycleOperationRow.Type,
    now: number,
  ) {
    const blockedBy = (blocker: "goal_dependents" | "task_purge_required") =>
      Effect.as(
        run(sql`UPDATE lifecycle_operations SET status = 'blocked',
            blocker = ${blocker}, updated_at = ${now}
          WHERE id = ${operation.id}`),
        Option.some(LifecycleOutcome.blocked({ blocker, operationId: operation.id })),
      );
    // A request recorded before another Goal came to wait for this conversation's Goal.
    if (yield* goalDependents(operation.target_id)) return yield* blockedBy("goal_dependents");
    const remaining = (yield* decodeId(
      yield* first(sql`SELECT coalesce(max(id), '') AS id FROM work_tasks
        WHERE origin_session_id = ${operation.target_id} AND deleted_at IS NULL`),
    )).id;
    if (remaining !== "") return yield* blockedBy("task_purge_required");
    yield* run(sql`UPDATE lifecycle_operations SET status = 'purging', updated_at = ${now}
      WHERE id = ${operation.id}`);
    yield* purgeSession(operation, now);
    return Option.none();
  });

  const finalizeSessionLifecycle = (operationId: string) =>
    Effect.gen(function* () {
      const found = yield* first(sql`SELECT * FROM lifecycle_operations WHERE id = ${operationId}`);
      if (!isTruthy(found)) return LifecycleOutcome.blocked({ blocker: "operation_not_found" });
      const operation = yield* decodeLifecycleOperation(found);
      if (operation.status === "completed")
        return LifecycleOutcome.completed({ operationId, targetId: operation.target_id });
      const now = yield* Clock.currentTimeMillis;
      const active = (yield* decodeId(
        yield* first(sql`SELECT coalesce(max(active_attempt_id), '') AS id FROM work_tasks
          WHERE origin_session_id = ${operation.target_id} AND active_attempt_id IS NOT NULL`),
      )).id;
      if (active !== "") {
        yield* run(sql`UPDATE lifecycle_operations SET status = 'waiting_for_stop', updated_at = ${now}
          WHERE id = ${operationId}`);
        return LifecycleOutcome.waiting_for_stop({ operationId, targetId: operation.target_id });
      }
      const kept = yield* Match.value(operation.intent).pipe(
        Match.when("restore", () =>
          Effect.as(
            run(sql`UPDATE sessions SET archived_at = NULL WHERE id = ${operation.target_id}`),
            Option.none(),
          ),
        ),
        Match.when("archive", () =>
          Effect.as(
            run(sql`UPDATE sessions
              SET archived_at = ${DateTime.formatIso(DateTime.makeUnsafe(now))}
              WHERE id = ${operation.target_id}`),
            Option.none(),
          ),
        ),
        Match.when("delete", () => deleteSession(operation, now)),
        Match.exhaustive,
      );
      return yield* Option.match(kept, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.as(
            run(sql`UPDATE lifecycle_operations SET status = 'completed', blocker = NULL,
                updated_at = ${now}, completed_at = ${now}
              WHERE id = ${operationId}`),
            LifecycleOutcome.completed({
              operationId,
              targetId: operation.target_id,
              intent: operation.intent,
            }),
          ),
      });
    }).pipe(sql.withTransaction);

  /**
   * Persist a task archive/delete request before touching the live child. The unique active-target
   * index serializes archive/delete/resume races; retries with the same key return the same row.
   */
  const requestTaskLifecycle = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly intent: LifecycleIntent;
    readonly idempotencyKey: string;
  }) =>
    Effect.gen(function* () {
      const retried = yield* first(sql`SELECT * FROM lifecycle_operations
        WHERE idempotency_key = ${input.idempotencyKey}`);
      if (isTruthy(retried))
        return lifecycleOperationView(yield* decodeLifecycleOperation(retried));
      const found = yield* first(sql`SELECT project_id, origin_session_id, agent_id, parent_run_id,
          active_attempt_id, archived_at, delete_requested_at, deleted_at, purge_receipt_id
        FROM work_tasks WHERE id = ${input.taskId} AND origin_session_id = ${input.sessionId}`);
      if (!isTruthy(found))
        return LifecycleRequest.blocked({ blocker: "task_not_found", operationId: null });
      const task = yield* decodeLifecycleTask(found);
      if (task.deleted_at !== null)
        return LifecycleRequest.completed({
          targetId: input.taskId,
          intent: "delete",
          receiptId: task.purge_receipt_id,
          operationId: null,
        });
      if (input.intent === "restore" && task.archived_at === null)
        return LifecycleRequest.blocked({ blocker: "task_not_archived", operationId: null });
      if (input.intent === "archive" && task.archived_at !== null)
        return LifecycleRequest.completed({
          targetId: input.taskId,
          intent: input.intent,
          operationId: null,
        });
      const now = yield* Clock.currentTimeMillis;
      const id = yield* crypto.randomUUIDv4();
      const status = task.active_attempt_id === null ? "requested" : "cancelling";
      yield* run(sql`INSERT INTO lifecycle_operations
        (id, project_id, origin_session_id, target_kind, target_id, intent, status,
         idempotency_key, requested_at, updated_at)
        VALUES (${id}, ${task.project_id}, ${task.origin_session_id}, 'task', ${input.taskId},
          ${input.intent}, ${status}, ${input.idempotencyKey}, ${now}, ${now})`);
      yield* Effect.when(
        run(sql`UPDATE work_tasks SET delete_requested_at = ${now}, updated_at = ${now}
          WHERE id = ${input.taskId}`),
        Effect.succeed(input.intent === "delete"),
      );
      return LifecycleRequest[status]({
        operationId: id,
        projectId: task.project_id,
        sessionId: task.origin_session_id,
        targetKind: "task",
        targetId: input.taskId,
        intent: input.intent,
        blocker: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: null,
        agentId: task.agent_id,
        activeAttemptId: task.active_attempt_id,
      });
    }).pipe(sql.withTransaction);

  const lifecycleTaskOf = (taskId: string) =>
    first(sql`SELECT project_id, origin_session_id, agent_id, parent_run_id, active_attempt_id,
        archived_at, delete_requested_at, deleted_at, purge_receipt_id
      FROM work_tasks WHERE id = ${taskId}`).pipe(Effect.flatMap(decodeLifecycleTask));

  const notifyLifecycle = (
    operation: typeof LifecycleOperationRow.Type,
    receiptId: string | null,
  ) =>
    operation.intent === "restore"
      ? Effect.void
      : Effect.asVoid(
          notifyParent({
            taskId: operation.target_id,
            kind: operation.intent === "delete" ? "deleted" : "archived",
            summary:
              operation.intent === "delete"
                ? "Subagent task deleted; adopted project knowledge was retained"
                : "Subagent task archived",
            idempotencyKey: `lifecycle:${operation.id}:${operation.intent}`,
            payload: { operationId: operation.id, receiptId },
          }),
        );

  const purgeTask = Effect.fnUntraced(function* (
    operation: typeof LifecycleOperationRow.Type,
    now: number,
  ) {
    const taskId = operation.target_id;
    yield* run(sql`UPDATE lifecycle_operations SET status = 'purging', updated_at = ${now}
      WHERE id = ${operation.id}`);
    const artifacts = (yield* run(sql`UPDATE work_artifacts SET locator = NULL, media_type = NULL,
        verification = 'source_deleted', source_deleted_at = ${now}, updated_at = ${now}
      WHERE task_id = ${taskId}`)).changes;
    yield* run(sql`DELETE FROM chat_metadata
      WHERE namespace = 'background-task-result' AND key = ${taskId}`);
    const events = (yield* run(sql`DELETE FROM run_events WHERE task_id = ${taskId}`)).changes;
    yield* run(sql`UPDATE agent_invocations SET message = '' WHERE task_id = ${taskId}`);
    yield* run(sql`UPDATE parent_notifications
      SET summary = 'Deleted task lifecycle notification', payload = '{}'
      WHERE task_id = ${taskId}`);
    const receiptId = yield* crypto.randomUUIDv4();
    const purgedCounts = yield* encodeJson({ artifacts, events });
    const retainedKinds = yield* encodeJson([
      "task_tombstone",
      "attempt_lineage",
      "answer_claims",
      "adopted_memory",
    ]);
    yield* run(sql`INSERT INTO purge_receipts
      (id, operation_id, project_id, target_kind, target_id, policy_version,
       purged_counts, retained_kinds, completed_at)
      VALUES (${receiptId}, ${operation.id}, ${operation.project_id}, 'task', ${taskId}, 1,
        ${purgedCounts}, ${retainedKinds}, ${now})`);
    yield* run(sql`UPDATE work_tasks SET title = 'Deleted task', request = '',
        agent_name = 'deleted subagent', archived_at = NULL, deleted_at = ${now},
        purge_receipt_id = ${receiptId}, updated_at = ${now}
      WHERE id = ${taskId}`);
    return receiptId;
  });

  const finalizeTaskLifecycle = (operationId: string) =>
    Effect.gen(function* () {
      const found = yield* first(sql`SELECT * FROM lifecycle_operations WHERE id = ${operationId}`);
      if (!isTruthy(found)) return LifecycleOutcome.blocked({ blocker: "operation_not_found" });
      const operation = yield* decodeLifecycleOperation(found);
      if (operation.status === "completed") {
        yield* notifyLifecycle(operation, null);
        return LifecycleOutcome.completed({ operationId, targetId: operation.target_id });
      }
      const task = yield* lifecycleTaskOf(operation.target_id);
      const now = yield* Clock.currentTimeMillis;
      if (task.active_attempt_id !== null) {
        yield* run(sql`UPDATE lifecycle_operations SET status = 'waiting_for_stop', updated_at = ${now}
          WHERE id = ${operationId}`);
        return LifecycleOutcome.waiting_for_stop({ operationId, targetId: operation.target_id });
      }
      const receiptId = yield* Match.value(operation.intent).pipe(
        Match.when("restore", () =>
          Effect.as(
            run(sql`UPDATE work_tasks SET archived_at = NULL, updated_at = ${now}
              WHERE id = ${operation.target_id}`),
            null,
          ),
        ),
        Match.when("archive", () =>
          Effect.as(
            run(sql`UPDATE work_tasks SET archived_at = ${now}, updated_at = ${now}
              WHERE id = ${operation.target_id}`),
            null,
          ),
        ),
        Match.when("delete", () => purgeTask(operation, now)),
        Match.exhaustive,
      );
      yield* run(sql`UPDATE lifecycle_operations SET status = 'completed', blocker = NULL,
          updated_at = ${now}, completed_at = ${now}
        WHERE id = ${operationId}`);
      yield* notifyLifecycle(operation, receiptId);
      return LifecycleOutcome.completed({
        operationId,
        targetId: operation.target_id,
        intent: operation.intent,
        receiptId,
      });
    }).pipe(sql.withTransaction);

  /** Finishes one lifecycle operation a crash left between request and completion. */
  const recoverLifecycleOperation = Effect.fnUntraced(function* (
    operation: typeof PendingLifecycleRow.Type,
  ) {
    if (operation.target_kind === "task") return yield* finalizeTaskLifecycle(operation.id);
    // A conversation another Goal waits for keeps its tasks; its finalize records why it stays.
    if (operation.intent === "delete" && !(yield* goalDependents(operation.target_id))) {
      const tasks = yield* decodeIds(
        yield* sql`SELECT id FROM work_tasks
          WHERE origin_session_id = ${operation.target_id} AND deleted_at IS NULL
          ORDER BY created_at, id`,
      );
      yield* Effect.forEach(
        tasks,
        (task) =>
          Effect.gen(function* () {
            const requested = yield* requestTaskLifecycle({
              sessionId: operation.target_id,
              taskId: task.id,
              intent: "delete",
              idempotencyKey: `session:${operation.id}:task:${task.id}`,
            });
            if (!LifecycleRequest.$is("completed")(requested) && isTruthy(requested.operationId))
              yield* finalizeTaskLifecycle(requested.operationId);
          }),
        { discard: true },
      );
    }
    return yield* finalizeSessionLifecycle(operation.id);
  });

  /** Lifecycle operations still between request and completion. */
  const unfinishedLifecycle = sql`status IN
    ('requested', 'cancelling', 'waiting_for_stop', 'purging', 'blocked')`;

  /**
   * Conversations whose unfinished delete recovery takes on. One another Goal still waits for is
   * left out: its delete stays blocked, and its own board keeps running.
   */
  const pendingSessionDeletes = Effect.flatMap(
    Effect.flatMap(
      sql`SELECT DISTINCT target_id AS id FROM lifecycle_operations
        WHERE target_kind = 'session' AND intent = 'delete' AND ${unfinishedLifecycle}`,
      decodeIds,
    ),
    (rows) =>
      Effect.filter(
        rows.map((row) => row.id),
        (sessionId) => Effect.map(goalDependents(sessionId), (waited) => !waited),
      ),
  );

  /**
   * Finishes lifecycle operations a crash left between request and completion. One that fails is
   * tried again on the next start; it must not stop the others or the service starting this.
   */
  const recoverLifecycleOperations = Effect.fnUntraced(function* () {
    const pending = yield* decodePendingLifecycleRows(
      yield* sql`SELECT id, target_kind, target_id, intent FROM lifecycle_operations
        WHERE ${unfinishedLifecycle}
        ORDER BY CASE target_kind WHEN 'task' THEN 0 ELSE 1 END, requested_at, id`,
    );
    yield* Effect.forEach(
      pending,
      (operation) =>
        recoverLifecycleOperation(operation).pipe(
          Effect.catch(
            logFailure("work_trace_lifecycle_not_recovered", { operationId: operation.id }),
          ),
        ),
      { discard: true },
    );
  });

  const archiveTask = (sessionId: string, taskId: string) =>
    Effect.gen(function* () {
      const existing =
        yield* first(sql`SELECT active_attempt_id, status, archived_at FROM work_tasks
        WHERE id = ${taskId} AND origin_session_id = ${sessionId}`);
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          active_attempt_id: Schema.NullOr(Schema.String),
          status: Schema.String,
          archived_at: Schema.NullOr(Schema.Finite),
        }),
      )(existing);
      if (Option.isNone(decoded)) return TaskArchive.blocked({ reason: "task_not_found" });
      const task = decoded.value;
      if (task.archived_at !== null) return TaskArchive.archived({ taskId });
      if (task.active_attempt_id !== null) return TaskArchive.blocked({ reason: "attempt_alive" });
      if (!["interrupted", "resumable", "completed", "failed", "cancelled"].includes(task.status))
        return TaskArchive.blocked({ reason: "task_not_archivable" });
      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`UPDATE work_tasks SET archived_at = ${now}, updated_at = ${now}
        WHERE id = ${taskId}`);
      return TaskArchive.archived({ taskId });
    }).pipe(sql.withTransaction);

  /**
   * Mark a user-requested retry on its task. Execution waits for the next valid parent run so the
   * child receives the current model, project tools, permission policy and abort ownership.
   */
  const requestResume = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly expectedAttemptId: string;
    readonly confirmUncertain: boolean;
  }) =>
    Effect.gen(function* () {
      const candidate = yield* first(sql`SELECT t.id, t.origin_session_id, t.agent_id, t.request,
          t.status, t.active_attempt_id, t.archived_at, t.delete_requested_at, t.deleted_at,
          a.id AS previous_attempt_id, a.attempt_number AS previous_attempt_number,
          a.status AS previous_status, a.thread_id
        FROM work_tasks t
        JOIN agent_run_attempts a ON a.task_id = t.id
        WHERE t.id = ${input.taskId} AND t.origin_session_id = ${input.sessionId}
        ORDER BY a.attempt_number DESC LIMIT 1`);
      const blocked = (reason: ResumeBlocker): ResumeRequest => ResumeRequest.blocked({ reason });
      if (!isTruthy(candidate)) return blocked("task_not_found");
      const task = yield* decodeResumeTask(candidate);
      if (task.deleted_at !== null || task.delete_requested_at !== null)
        return blocked("task_deleted");
      if (task.archived_at !== null) return blocked("task_archived");
      if (task.origin_session_id === null) return blocked("origin_deleted");
      if (task.agent_id === null) return blocked("agent_deleted");
      if (isTruthy(task.active_attempt_id)) return blocked("attempt_alive");
      if (task.status === "completed") return blocked("task_terminal");
      if (task.previous_attempt_id !== input.expectedAttemptId) return blocked("stale_attempt");
      if ((yield* pendingToolsOf(task.previous_attempt_id)).length > 0 && !input.confirmUncertain)
        return blocked("uncertain_side_effect");

      const now = yield* Clock.currentTimeMillis;
      yield* run(sql`UPDATE work_tasks SET retry_requested_at = ${now},
          retry_confirm_uncertain = ${input.confirmUncertain ? 1 : 0}, updated_at = ${now}
        WHERE id = ${task.id}`);
      return ResumeRequest.queued({ taskId: task.id, expectedAttemptId: task.previous_attempt_id });
    }).pipe(sql.withTransaction);

  /**
   * Claims the retries the user asked for in this session for one parent run. A retry that can no
   * longer start is cleared and reported to the parent instead of waiting forever.
   */
  const claimRetries = (sessionId: string, parentRunId: string) =>
    Effect.gen(function* () {
      const requested = yield* decodeRetryRows(
        yield* sql`SELECT t.id, a.id AS previous_attempt_id, t.retry_confirm_uncertain
          FROM work_tasks t JOIN agent_run_attempts a ON a.id =
            (SELECT latest.id FROM agent_run_attempts latest
             WHERE latest.task_id = t.id ORDER BY latest.attempt_number DESC LIMIT 1)
          WHERE t.origin_session_id = ${sessionId} AND t.retry_requested_at IS NOT NULL
          ORDER BY t.retry_requested_at, t.id`,
      );
      // Each retry is taken off its task before it starts, so a second claim skips it.
      const claims = yield* Effect.forEach(requested, (task) =>
        Effect.when(
          claimResume({
            sessionId,
            taskId: task.id,
            expectedAttemptId: task.previous_attempt_id,
            parentRunId,
            parentToolCallId: `retry:${task.previous_attempt_id}`,
            confirmUncertain: task.retry_confirm_uncertain === 1,
          }).pipe(
            Effect.flatMap((claim) =>
              ResumeClaim.$match(claim, {
                // Spelled out so the claim keeps its type; a bare generic loses it.
                started: (started) => Effect.succeedSome(started),
                blocked: ({ reason }) =>
                  Effect.as(
                    notifyParent({
                      taskId: task.id,
                      kind: "resume_blocked",
                      summary: `Requested retry could not start: ${reason}`,
                      idempotencyKey: `retry:${task.previous_attempt_id}:blocked`,
                      payload: { reason },
                    }),
                    Option.none(),
                  ),
              }),
            ),
          ),
          Effect.map(
            run(sql`UPDATE work_tasks SET retry_requested_at = NULL
              WHERE id = ${task.id} AND retry_requested_at IS NOT NULL`),
            (acquired) => acquired.changes === 1,
          ),
        ),
      );
      return EffectArray.getSomes(claims.map(Option.flatten));
    }).pipe(sql.withTransaction);

  const events = (sessionId: string, afterCursor = 0, limit = 200) =>
    sql`SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
        attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
      FROM run_events
      WHERE origin_session_id = ${sessionId} AND seq > ${Math.max(0, afterCursor)}
        AND visibility <> 'internal' AND redaction <> 'omitted'
      ORDER BY seq LIMIT ${Math.min(Math.max(1, limit), 500)}`.pipe(
      Effect.flatMap(decodeStoredEventRows),
      Effect.flatMap(eventViews),
    );

  const latestCursor = (sessionId: string) =>
    first(sql`SELECT coalesce(max(seq), 0) AS seq FROM run_events
      WHERE origin_session_id = ${sessionId}`).pipe(
      Effect.flatMap(decodeCursor),
      Effect.map((row) => row.seq),
    );

  const projectLatestCursor = (projectId: string) =>
    first(sql`SELECT coalesce(max(e.seq), 0) AS seq
      FROM run_events e JOIN work_tasks t ON t.id = e.task_id WHERE t.project_id = ${projectId}`).pipe(
      Effect.flatMap(decodeCursor),
      Effect.map((row) => row.seq),
    );

  const snapshot = (sessionId: string, afterCursor = 0, limit = 500) =>
    Effect.gen(function* () {
      const upperCursor = yield* latestCursor(sessionId);
      const boundedLimit = Math.min(Math.max(1, limit), 500);
      const rows = yield* decodeStoredEventRows(
        yield* sql`SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
            attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
          FROM run_events
          WHERE origin_session_id = ${sessionId} AND seq > ${Math.max(0, afterCursor)}
            AND seq <= ${upperCursor}
            AND visibility <> 'internal' AND redaction <> 'omitted'
          ORDER BY seq LIMIT ${boundedLimit}`,
      );
      const cursor =
        rows.length === boundedLimit ? (rows.at(-1)?.cursor ?? afterCursor) : upperCursor;
      return { cursor, events: yield* eventViews(rows) };
    }).pipe(sql.withTransaction);

  const latestCursorEffect = (sessionId: string) =>
    latestCursor(sessionId).pipe(
      Effect.mapError((cause) =>
        WorkTraceReadFailed.make({
          operation: "latest_cursor",
          reason: ReadFailed.make({}),
          cause,
        }),
      ),
    );

  const snapshotEffect = (options: { readonly sessionId: string; readonly afterCursor: number }) =>
    snapshot(options.sessionId, options.afterCursor).pipe(
      Effect.mapError((cause) =>
        WorkTraceReadFailed.make({ operation: "snapshot", reason: ReadFailed.make({}), cause }),
      ),
    );

  const waitForChangeEffect = Effect.fnUntraced(function* (options: {
    readonly sessionId: string;
    readonly afterCursor: number;
    readonly heartbeatMs?: number;
  }) {
    const { sessionId, afterCursor } = options;
    if ((yield* latestCursorEffect(sessionId)) > afterCursor) return "event" as const;
    const wanted = (change: TraceChange) =>
      change.sessionId === sessionId && (change.kind === "progress" || change.cursor > afterCursor);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        // Close the gap between the first durable read and subscribing.
        if ((yield* latestCursorEffect(sessionId)) > afterCursor) return "event" as const;
        const result = yield* PubSub.take(subscription).pipe(
          Effect.repeat({ until: wanted }),
          Effect.timeoutOption(Math.max(1, options.heartbeatMs ?? 15_000)),
        );
        return Option.match(result, {
          onNone: () => "heartbeat" as const,
          onSome: (change) => change.kind,
        });
      }),
    );
  });

  const attemptHandle = (taskId: string, attemptId: string) =>
    Effect.gen(function* () {
      const row = yield* first(sql`SELECT * FROM agent_run_attempts
        WHERE id = ${attemptId} AND task_id = ${taskId}`);
      return isTruthy(row) ? handleOf(yield* decodeAttempt(row)) : null;
    });

  const activeAttemptForAgent = (agentId: string) =>
    Effect.gen(function* () {
      const row = yield* first(sql`SELECT a.* FROM agent_run_attempts a
        JOIN work_tasks t ON t.id = a.task_id
        WHERE t.agent_id = ${agentId} AND a.status IN ('queued', 'running', 'waiting', 'blocked')
        ORDER BY a.created_at DESC LIMIT 1`);
      return isTruthy(row) ? handleOf(yield* decodeAttempt(row)) : null;
    });

  /** Fails live attempts whose beats stopped: their fiber ended without settling, or hangs. */
  const failLostAttempts = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const lost = yield* decodeLostAttemptRows(
      yield* sql`SELECT a.id, a.task_id, a.invocation_id, a.attempt_number, a.chat_run_id,
          a.thread_id, a.status, t.origin_session_id
        FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
        WHERE a.status IN ${liveStatuses} AND t.origin_session_id IS NOT NULL
          AND coalesce(a.heartbeat_at, a.created_at)
            < ${now - heartbeatLostMs}`,
    );
    yield* Effect.forEach(
      lost,
      (attempt) =>
        transitionAttempt(
          handleOf(attempt),
          attempt.origin_session_id ?? "",
          "failed",
          "attempt_failed",
          "Stopped responding",
          { reason: AttemptFailureReason.cases.HeartbeatLost.make({}) },
          false,
        ).pipe(Effect.catch(logFailure("work_trace_lost_attempt_not_recorded"))),
      { discard: true },
    );
  });
  yield* Effect.forever(
    Effect.sleep(heartbeatIntervalMs).pipe(
      Effect.andThen(failLostAttempts),
      Effect.catch(logFailure("work_trace_watchdog_failed")),
    ),
  ).pipe(Effect.forkScoped);

  return {
    recoveredAttempts,
    startAttempt,
    recordSteer,
    appendEvent,
    notifyParent,
    consumeParentNotifications,
    holdParentNotifications: (sessionId: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        run(sql`INSERT INTO parent_notification_holds (session_id, held_at)
          SELECT id, ${now} FROM sessions WHERE id = ${sessionId}
          ON CONFLICT(session_id) DO UPDATE SET held_at = excluded.held_at`),
      ).pipe(Effect.asVoid),
    resumeParentNotifications: (sessionId: string) =>
      Effect.asVoid(
        run(sql`DELETE FROM parent_notification_holds WHERE session_id = ${sessionId}`),
      ),
    parentNotificationsHeld: (sessionId: string) =>
      Effect.map(
        first(sql`SELECT 1 FROM parent_notification_holds WHERE session_id = ${sessionId}`),
        (row) => row !== undefined,
      ),
    /** Durable wake-up source. Reading does not mark a notification delivered. */
    pendingParentNotificationSessions:
      sql`SELECT DISTINCT origin_session_id FROM parent_notifications n
        WHERE delivered_at IS NULL AND origin_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM parent_notification_holds h WHERE h.session_id = n.origin_session_id
          )`.pipe(
        Effect.flatMap(decodeOriginSessions),
        Effect.map((rows) => rows.map((row) => row.origin_session_id)),
      ),
    releaseParentNotifications,
    transitionAttempt,
    beat,
    toolStarted,
    toolSettled,
    keepAlive,
    recordArtifact,
    setArtifactVerification,
    markArtifactSourceDeleted,
    artifactsForTask,
    finalizeAnswerClaim,
    taskTree,
    projectTaskTree,
    taskDetail,
    projectTaskDetail,
    claimResume,
    requestResume,
    requestSessionLifecycle,
    finalizeSessionLifecycle,
    requestTaskLifecycle,
    finalizeTaskLifecycle,
    pendingSessionDeletes,
    recoverLifecycleOperations,
    archiveTask,
    claimRetries,
    events,
    snapshot,
    latestCursor,
    projectLatestCursor,
    waitForChangeEffect,
    snapshotEffect,
    attemptHandle,
    activeAttemptForAgent,
  };
});

export class WorkTraceStore extends Context.Service<WorkTraceStore, Effect.Success<typeof make>>()(
  "memory-agent/work-trace/store/WorkTraceStore",
) {
  static readonly layer = Layer.effect(WorkTraceStore, make).pipe(Layer.provide(NodeCrypto.layer));
}
