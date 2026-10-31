import { HashSet } from "effect";
import { Function as EffectFunction } from "effect";
import { Schema } from "effect";
import { JsonValue } from "../json.ts";
import { MemoryCandidateView, MemoryUsageView } from "../memory/contracts.ts";
import { ExternalAgentFailureCode } from "../runtime/shown-failure.ts";

/** Stable identity of a child agent. One-off agents have no reusable name. */
export const AgentIdentityKind = Schema.Literals(["one_off", "named"]);
export type AgentIdentityKind = typeof AgentIdentityKind.Type;

/** Why the parent addressed an agent. A steer joins the current attempt; resume creates a new one. */
export const InvocationKind = Schema.Literals(["start", "continue", "steer", "resume"]);
export type InvocationKind = typeof InvocationKind.Type;

export const InvocationStatus = Schema.Literals([
  "accepted",
  "steered",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type InvocationStatus = typeof InvocationStatus.Type;

/** Logical state shown for a Task across all of its physical attempts. */
export const TaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "blocked",
  "interrupted",
  "resumable",
  "resuming",
  "completed",
  "failed",
  "cancelled",
  "archived",
  "deleted",
]);
export type TaskStatus = typeof TaskStatus.Type;

/** Physical lifecycle of one provider run. Whether a retry is safe is derived from run events. */
export const AttemptStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "blocked",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);
export type AttemptStatus = typeof AttemptStatus.Type;

export const ResumeReason = Schema.Literals([
  "server_restarted",
  "connection_lost",
  "provider_failed",
  "user_cancelled",
  "approval_expired",
  "unknown",
]);
export type ResumeReason = typeof ResumeReason.Type;

export const EvidenceVerification = Schema.Literals([
  "unverified",
  "verified",
  "invalidated",
  "unavailable",
  "source_deleted",
]);
export type EvidenceVerification = typeof EvidenceVerification.Type;

export const ArtifactKind = Schema.Literals(["file", "generated", "external"]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** Artifact metadata points at a result; generated contents remain in their owning store. */
export const ArtifactLocator = Schema.TaggedUnion({
  file: { path: Schema.String, sha256: Schema.String },
  generated: { reference: Schema.String },
  external: { reference: Schema.String },
});
export type ArtifactLocator = typeof ArtifactLocator.Type;

/** User-visible trace never exposes internal reasoning. */
export const TraceVisibility = Schema.Literals(["public", "summary", "internal"]);
export type TraceVisibility = typeof TraceVisibility.Type;
export const RedactionState = Schema.Literals(["clear", "redacted", "omitted"]);
export type RedactionState = typeof RedactionState.Type;

export const ToolExecutionState = Schema.Literals([
  "requested",
  "waiting_approval",
  "approved",
  "denied",
  "running",
  "completed",
  "failed",
  "uncertain",
]);
export type ToolExecutionState = typeof ToolExecutionState.Type;

/** Lifecycle changes only. Where an attempt is right now lives in its heartbeat, not in events. */
export const RunEventKind = Schema.Literals([
  "attempt_queued",
  "attempt_started",
  "approval_waiting",
  "approval_resolved",
  "steered",
  "attempt_interrupted",
  "attempt_completed",
  "attempt_failed",
  "attempt_cancelled",
  "resume_requested",
]);
export type RunEventKind = typeof RunEventKind.Type;

/** What a live attempt is doing, as its last heartbeat said. */
export const HeartbeatState = Schema.Literals(["working", "idle", "waiting"]);
export type HeartbeatState = typeof HeartbeatState.Type;

/** Where an attempt was when it failed. */
export const AttemptFailureStage = Schema.Literals([
  "start",
  "model",
  "tool",
  "approval",
  "finish",
  "process",
  "restart",
]);
export type AttemptFailureStage = typeof AttemptFailureStage.Type;

/**
 * Why an attempt failed. Only these codes and safe fields are stored and shown; provider bodies,
 * command output and paths never are.
 */
export const AttemptFailureReason = Schema.TaggedUnion({
  /** The model stream reported an error. */
  ModelRunError: {},
  /** The model stream itself failed. */
  ModelStreamFailed: {},
  /** The model kept repeating a tool call whose result could not change. */
  RepeatedToolCall: {},
  /** The child's own runtime died: a defect, or a store write it could not finish. */
  AgentCrashed: {},
  /** The attempt stopped beating without settling. */
  HeartbeatLost: {},
  /** The server stopped while the attempt was live. */
  ServerRestarted: {},
  /** An external ACP agent ended without an answer. */
  ExternalAgentFailed: { code: ExternalAgentFailureCode },
  /** A background command exited unsuccessfully or was killed. */
  ProcessExited: {
    exitCode: Schema.NullOr(Schema.Finite),
    signal: Schema.NullOr(Schema.String),
  },
  ProcessTimedOut: {},
  /** A background operation failed before it produced a result. */
  OperationFailed: {},
  /** The operation ended but its result could not be stored. */
  ResultStorageFailed: {},
});
export type AttemptFailureReason = typeof AttemptFailureReason.Type;

/** The reason's code as reports show it: the case name, never its fields. */
export const attemptFailureCode = AttemptFailureReason.match({
  ModelRunError: () => "ModelRunError",
  ModelStreamFailed: () => "ModelStreamFailed",
  RepeatedToolCall: () => "RepeatedToolCall",
  AgentCrashed: () => "AgentCrashed",
  HeartbeatLost: () => "HeartbeatLost",
  ServerRestarted: () => "ServerRestarted",
  ExternalAgentFailed: () => "ExternalAgentFailed",
  ProcessExited: () => "ProcessExited",
  ProcessTimedOut: () => "ProcessTimedOut",
  OperationFailed: () => "OperationFailed",
  ResultStorageFailed: () => "ResultStorageFailed",
});

export const AttemptFailure = Schema.Struct({
  reason: AttemptFailureReason,
  stage: AttemptFailureStage,
});
export type AttemptFailure = typeof AttemptFailure.Type;

export const AgentIdentity = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  kind: AgentIdentityKind,
  name: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
});
export type AgentIdentity = typeof AgentIdentity.Type;

export const WorkTask = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  parentTaskId: Schema.NullOr(Schema.String),
  parentRunId: Schema.String,
  parentToolCallId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  agentName: Schema.String,
  status: TaskStatus,
  title: Schema.String,
  request: Schema.String,
  activeAttemptId: Schema.NullOr(Schema.String),
  originDeletedAt: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type WorkTask = typeof WorkTask.Type;

export const AgentInvocation = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  parentRunId: Schema.String,
  parentToolCallId: Schema.String,
  kind: InvocationKind,
  status: InvocationStatus,
  message: Schema.String,
  targetAttemptId: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  finishedAt: Schema.NullOr(Schema.Finite),
});
export type AgentInvocation = typeof AgentInvocation.Type;

export const AgentRunAttempt = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  invocationId: Schema.String,
  attemptNumber: Schema.Finite,
  chatRunId: Schema.String,
  threadId: Schema.String,
  status: AttemptStatus,
  resumedFromAttemptId: Schema.NullOr(Schema.String),
  supersededByAttemptId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Finite),
  finishedAt: Schema.NullOr(Schema.Finite),
});
export type AgentRunAttempt = typeof AgentRunAttempt.Type;

export const RunEvent = Schema.Struct({
  id: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  taskId: Schema.String,
  invocationId: Schema.String,
  attemptId: Schema.String,
  sequence: Schema.Finite,
  kind: RunEventKind,
  visibility: TraceVisibility,
  redaction: RedactionState,
  summary: Schema.String,
  occurredAt: Schema.Finite,
});
export type RunEvent = typeof RunEvent.Type;

export const ArtifactRef = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  kind: ArtifactKind,
  locator: Schema.NullOr(ArtifactLocator),
  mediaType: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  sourceDeletedAt: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type ArtifactRef = typeof ArtifactRef.Type;

const activeAttemptStatuses = HashSet.fromIterable<AttemptStatus>([
  "queued",
  "running",
  "waiting",
  "blocked",
]);
const terminalAttemptStatuses = HashSet.fromIterable<AttemptStatus>([
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

export const isActiveAttemptStatus = (status: AttemptStatus) =>
  HashSet.has(activeAttemptStatuses, status);
export const isTerminalAttemptStatus = (status: AttemptStatus) =>
  HashSet.has(terminalAttemptStatuses, status);

/** Where an attempt may go from each status besides staying; a terminal status goes nowhere. */
const attemptTransitions: Record<AttemptStatus, ReadonlyArray<AttemptStatus>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting", "blocked", "interrupted", "completed", "failed", "cancelled"],
  waiting: ["running", "interrupted", "failed", "cancelled"],
  blocked: ["running", "interrupted", "failed", "cancelled"],
  interrupted: [],
  completed: [],
  failed: [],
  cancelled: [],
};

const canTransitionAttemptBody = (from: AttemptStatus, to: AttemptStatus) =>
  from === to || attemptTransitions[from].includes(to);
export const canTransitionAttempt: {
  (to: AttemptStatus): (from: AttemptStatus) => ReturnType<typeof canTransitionAttemptBody>;
} & typeof canTransitionAttemptBody = EffectFunction.dual(2, canTransitionAttemptBody);

/** A resume always creates a new attempt; terminal attempts themselves never return to running. */
export const resumeCreatesNewAttempt = (kind: InvocationKind) => kind === "resume";

/** Internal events are durable for diagnostics but are never part of the user trace projection. */
export const isUserVisibleTrace = (event: Pick<RunEvent, "visibility" | "redaction">) =>
  event.visibility !== "internal" && event.redaction !== "omitted";

export const LifecycleIntent = Schema.Literals(["archive", "restore", "delete"]);
export type LifecycleIntent = typeof LifecycleIntent.Type;

/**
 * An archive, restore or delete as the page reads it: done, waiting for a live attempt to stop
 * (finishing it again completes it), or blocked with why. The store's own views carry more.
 */
export const LifecycleResult = Schema.TaggedUnion({
  completed: {
    operationId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    targetId: Schema.String,
    intent: Schema.optionalKey(LifecycleIntent),
    receiptId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  },
  waiting_for_stop: { operationId: Schema.String, targetId: Schema.String },
  blocked: { blocker: Schema.String },
});
export type LifecycleResult = typeof LifecycleResult.Type;

/** Where an attempt is, as its last heartbeat said. */
export const TraceHeartbeatView = Schema.Struct({
  state: HeartbeatState,
  /** One line about the current step. */
  step: Schema.NullOr(Schema.String),
  at: Schema.Finite,
});
export type TraceHeartbeatView = typeof TraceHeartbeatView.Type;

/** One task of a trace tree, with its latest attempt. */
export const TraceTaskView = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  parentTaskId: Schema.NullOr(Schema.String),
  parentRunId: Schema.String,
  parentToolCallId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  agentName: Schema.String,
  status: TaskStatus,
  title: Schema.String,
  request: Schema.String,
  activeAttemptId: Schema.NullOr(Schema.String),
  latestAttemptId: Schema.NullOr(Schema.String),
  latestAttemptStatus: Schema.NullOr(AttemptStatus),
  latestAttemptNumber: Schema.NullOr(Schema.Finite),
  latestResumedFromAttemptId: Schema.NullOr(Schema.String),
  /** Where the latest attempt is, as its last heartbeat said. */
  heartbeat: Schema.NullOr(TraceHeartbeatView),
  /** Why the latest attempt failed, if it did. */
  latestFailure: Schema.NullOr(AttemptFailure),
  archivedAt: Schema.NullOr(Schema.Finite),
  deleteRequestedAt: Schema.NullOr(Schema.Finite),
  deletedAt: Schema.NullOr(Schema.Finite),
  purgeReceiptId: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TraceTaskView = typeof TraceTaskView.Type;

export const TraceAttemptView = Schema.Struct({
  id: Schema.String,
  invocationId: Schema.String,
  attemptNumber: Schema.Finite,
  chatRunId: Schema.String,
  threadId: Schema.String,
  status: AttemptStatus,
  resumedFromAttemptId: Schema.NullOr(Schema.String),
  supersededByAttemptId: Schema.NullOr(Schema.String),
  heartbeat: Schema.NullOr(TraceHeartbeatView),
  /** Tool calls the attempt started and never settled. */
  pendingToolCallIds: Schema.Array(Schema.String),
  failure: Schema.NullOr(AttemptFailure),
  startedAt: Schema.NullOr(Schema.Finite),
  finishedAt: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TraceAttemptView = typeof TraceAttemptView.Type;

/** A session's or project's tasks, and the trace cursor they were read at. */
export const TraceTreeSnapshot = Schema.Struct({
  cursor: Schema.Finite,
  tasks: Schema.Array(TraceTaskView),
});
export type TraceTreeSnapshot = typeof TraceTreeSnapshot.Type;

export const TraceFinalAnswerClaimView = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  parentRunId: Schema.String,
  parentMessageId: Schema.String,
  sources: Schema.Array(Schema.Struct({ taskId: Schema.String, attemptId: Schema.String })),
  notificationIds: Schema.Array(Schema.String),
  createdAt: Schema.Finite,
});
export type TraceFinalAnswerClaimView = typeof TraceFinalAnswerClaimView.Type;

export const TraceArtifactView = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  kind: ArtifactKind,
  /** Null only for source-deleted tombstones. */
  locator: Schema.NullOr(ArtifactLocator),
  mediaType: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  sourceDeletedAt: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type TraceArtifactView = typeof TraceArtifactView.Type;

/** A trace event the user may see: never an internal or omitted one (`isUserVisibleTrace`). */
export const TraceEventView = Schema.Struct({
  cursor: Schema.Finite,
  id: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  taskId: Schema.String,
  invocationId: Schema.String,
  attemptId: Schema.String,
  attemptSequence: Schema.Finite,
  kind: RunEventKind,
  visibility: Schema.Literals(["public", "summary"]),
  redaction: Schema.Literals(["clear", "redacted"]),
  summary: Schema.String,
  payload: JsonValue,
  occurredAt: Schema.Finite,
});
export type TraceEventView = typeof TraceEventView.Type;

/** The trace events after a cursor, and the cursor to continue after. */
export const TraceEventPage = Schema.Struct({
  cursor: Schema.Finite,
  events: Schema.Array(TraceEventView),
});
export type TraceEventPage = typeof TraceEventPage.Type;

/**
 * One SSE event of a conversation's trace stream: `snapshot` first, then each written event as
 * `trace`. The `id` is the cursor the page continues after.
 */
export const TraceStreamEvent = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    event: Schema.Literal("snapshot"),
    data: Schema.fromJsonString(TraceEventPage),
  }),
  Schema.Struct({
    id: Schema.String,
    event: Schema.Literal("trace"),
    data: Schema.fromJsonString(TraceEventView),
  }),
  /** A child's beat or current step changed: no event was written, the page rereads the tree. */
  Schema.Struct({
    event: Schema.Literal("progress"),
    data: Schema.fromJsonString(Schema.Struct({})),
  }),
  /** Nothing changed for a while; keeps the connection open. */
  Schema.Struct({
    event: Schema.Literal("heartbeat"),
    data: Schema.fromJsonString(Schema.Struct({ cursor: Schema.Finite })),
  }),
]);
export type TraceStreamEvent = typeof TraceStreamEvent.Type;

/** The trace could not be read, so its stream ended; the page connects again. */
export const TraceEventsLost = Schema.Struct({ error: Schema.Literal("trace_events_unavailable") });
export type TraceEventsLost = typeof TraceEventsLost.Type;

/** One task with its attempt lineage, checkpoints and visible events. */
export const TraceTaskDetail = Schema.Struct({
  task: TraceTaskView,
  attempts: Schema.Array(TraceAttemptView),
  artifacts: Schema.Array(TraceArtifactView),
  answerClaims: Schema.Array(TraceFinalAnswerClaimView),
  /** Present on HTTP detail projections; omitted by the lower-level trace store. */
  memoryCandidates: Schema.optionalKey(Schema.Array(MemoryCandidateView)),
  /** Retrieval and actual-use events are separate so recall does not imply answer influence. */
  memoryUsage: Schema.optionalKey(Schema.Array(MemoryUsageView)),
  events: Schema.Array(TraceEventView),
});
export type TraceTaskDetail = typeof TraceTaskDetail.Type;

/** Why a task's retry cannot start. */
export const ResumeBlocker = Schema.Literals([
  "task_not_found",
  "task_archived",
  "task_deleted",
  "attempt_alive",
  "task_terminal",
  "uncertain_side_effect",
  "stale_attempt",
  "origin_deleted",
  "agent_deleted",
]);
export type ResumeBlocker = typeof ResumeBlocker.Type;

/** A user's retry of a task: queued for the next parent run, or why it cannot be. */
export const ResumeTaskResult = Schema.TaggedUnion({
  queued: { taskId: Schema.String, expectedAttemptId: Schema.String },
  blocked: { reason: ResumeBlocker },
});
export type ResumeTaskResult = typeof ResumeTaskResult.Type;
