import { Schema } from "effect";

/** Stable identity of a child agent. One-off agents have no reusable name. */
export const AgentIdentityKind = Schema.Literal("one_off", "named");
export type AgentIdentityKind = typeof AgentIdentityKind.Type;

/** Why the parent addressed an agent. A steer joins the current attempt; resume creates a new one. */
export const InvocationKind = Schema.Literal("start", "continue", "steer", "resume");
export type InvocationKind = typeof InvocationKind.Type;

export const InvocationStatus = Schema.Literal(
  "accepted",
  "steered",
  "running",
  "completed",
  "failed",
  "cancelled",
);
export type InvocationStatus = typeof InvocationStatus.Type;

/** Logical state shown for a Task across all of its physical attempts. */
export const TaskStatus = Schema.Literal(
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
);
export type TaskStatus = typeof TaskStatus.Type;

/** Physical lifecycle of one provider run. Resumability is a separate derived decision. */
export const AttemptStatus = Schema.Literal(
  "queued",
  "running",
  "waiting",
  "blocked",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
);
export type AttemptStatus = typeof AttemptStatus.Type;

export const ResumeReason = Schema.Literal(
  "server_restarted",
  "connection_lost",
  "provider_failed",
  "user_cancelled",
  "approval_expired",
  "unknown",
);
export type ResumeReason = typeof ResumeReason.Type;

export const ResumeBlocker = Schema.Literal(
  "attempt_alive",
  "task_terminal",
  "active_attempt_exists",
  "missing_checkpoint",
  "uncertain_side_effect",
  "pending_approval",
  "legacy_record",
  "not_authorized",
);
export type ResumeBlocker = typeof ResumeBlocker.Type;

export const Resumability = Schema.Union(
  Schema.Struct({ state: Schema.Literal("not_needed") }),
  Schema.Struct({
    state: Schema.Literal("available"),
    reason: ResumeReason,
    checkpointId: Schema.String,
    requiresConfirmation: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal("blocked"),
    reason: ResumeReason,
    blockers: Schema.Array(ResumeBlocker),
  }),
);
export type Resumability = typeof Resumability.Type;

/** A report returning is not evidence that the parent reviewed or used it. */
export const ReportDisposition = Schema.Literal(
  "returned",
  "reviewed",
  "used",
  "not_used",
  "superseded",
);
export type ReportDisposition = typeof ReportDisposition.Type;

export const EvidenceSourceKind = Schema.Literal(
  "message",
  "tool_call",
  "tool_result",
  "file",
  "artifact",
  "checkpoint",
  "memory",
);
export type EvidenceSourceKind = typeof EvidenceSourceKind.Type;

export const EvidenceVerification = Schema.Literal(
  "unverified",
  "verified",
  "invalidated",
  "unavailable",
  "source_deleted",
);
export type EvidenceVerification = typeof EvidenceVerification.Type;

/** A durable pointer to source material. It identifies content without copying that content. */
export const EvidenceLocator = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("message"),
    threadId: Schema.String,
    messageId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool_call", "tool_result"),
    threadId: Schema.String,
    toolCallId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    sha256: Schema.String,
    startLine: Schema.optional(Schema.Number),
    endLine: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("artifact"), artifactId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("checkpoint"), checkpointId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("memory"), memoryId: Schema.String }),
);
export type EvidenceLocator = typeof EvidenceLocator.Type;

export const ArtifactKind = Schema.Literal("file", "generated", "external");
export type ArtifactKind = typeof ArtifactKind.Type;

/** Artifact metadata points at a result; generated contents remain in their owning store. */
export const ArtifactLocator = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String, sha256: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("generated"), reference: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("external"), reference: Schema.String }),
);
export type ArtifactLocator = typeof ArtifactLocator.Type;

/** User-visible trace never exposes internal reasoning. */
export const TraceVisibility = Schema.Literal("public", "summary", "internal");
export type TraceVisibility = typeof TraceVisibility.Type;
export const RedactionState = Schema.Literal("clear", "redacted", "omitted");
export type RedactionState = typeof RedactionState.Type;

export const ToolExecutionState = Schema.Literal(
  "requested",
  "waiting_approval",
  "approved",
  "denied",
  "running",
  "completed",
  "failed",
  "uncertain",
);
export type ToolExecutionState = typeof ToolExecutionState.Type;

export const RunEventKind = Schema.Literal(
  "attempt_queued",
  "attempt_started",
  "activity",
  "tool_requested",
  "approval_waiting",
  "approval_resolved",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "tool_uncertain",
  "steered",
  "checkpoint_created",
  "attempt_interrupted",
  "attempt_completed",
  "attempt_failed",
  "attempt_cancelled",
  "resume_requested",
  "resume_started",
  "report_returned",
  "report_reviewed",
  "report_used",
  "report_not_used",
  "report_superseded",
  "recovery_queued",
  "recovery_blocked",
  "parent_notified",
  "task_archived",
);
export type RunEventKind = typeof RunEventKind.Type;

export const AgentIdentity = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  kind: AgentIdentityKind,
  name: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
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
  originDeletedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
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
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
});
export type AgentInvocation = typeof AgentInvocation.Type;

export const AgentRunAttempt = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  invocationId: Schema.String,
  attemptNumber: Schema.Number,
  chatRunId: Schema.String,
  threadId: Schema.String,
  status: AttemptStatus,
  resumedFromAttemptId: Schema.NullOr(Schema.String),
  supersededByAttemptId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  resumability: Resumability,
});
export type AgentRunAttempt = typeof AgentRunAttempt.Type;

export const RunEvent = Schema.Struct({
  id: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  taskId: Schema.String,
  invocationId: Schema.String,
  attemptId: Schema.String,
  sequence: Schema.Number,
  kind: RunEventKind,
  visibility: TraceVisibility,
  redaction: RedactionState,
  summary: Schema.String,
  occurredAt: Schema.Number,
});
export type RunEvent = typeof RunEvent.Type;

export const WorkCheckpoint = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  eventSequence: Schema.Number,
  transcriptMessageId: Schema.NullOr(Schema.String),
  completedToolCallIds: Schema.Array(Schema.String),
  uncertainToolCallIds: Schema.Array(Schema.String),
  pendingApprovalIds: Schema.Array(Schema.String),
  remainingWork: Schema.String,
  createdAt: Schema.Number,
});
export type WorkCheckpoint = typeof WorkCheckpoint.Type;

export const EvidenceRef = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  sourceKind: EvidenceSourceKind,
  locator: Schema.NullOr(EvidenceLocator),
  verification: EvidenceVerification,
  visibility: TraceVisibility,
  redaction: RedactionState,
  sourceDeletedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type EvidenceRef = typeof EvidenceRef.Type;

export const ArtifactRef = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  kind: ArtifactKind,
  locator: Schema.NullOr(ArtifactLocator),
  mediaType: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  sourceDeletedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ArtifactRef = typeof ArtifactRef.Type;

export const ReportAdoption = Schema.Struct({
  taskId: Schema.String,
  attemptId: Schema.String,
  disposition: ReportDisposition,
  supersededByAttemptId: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type ReportAdoption = typeof ReportAdoption.Type;

export const MemoryCandidateStatus = Schema.Literal(
  "proposed",
  "confirmed",
  "conversation_only",
  "rejected",
  "promoted",
  "superseded",
);
export type MemoryCandidateStatus = typeof MemoryCandidateStatus.Type;

export const MemoryCandidate = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  evidenceRefIds: Schema.Array(Schema.String),
  status: MemoryCandidateStatus,
  requiresUserConfirmation: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type MemoryCandidate = typeof MemoryCandidate.Type;

export const DecisionStatus = Schema.Literal("proposed", "confirmed", "rejected", "superseded");
export type DecisionStatus = typeof DecisionStatus.Type;
export const WorkDecision = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  evidenceRefIds: Schema.Array(Schema.String),
  status: DecisionStatus,
  decidedBy: Schema.Literal("user", "assistant"),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type WorkDecision = typeof WorkDecision.Type;

const activeAttemptStatuses = new Set<AttemptStatus>(["queued", "running", "waiting", "blocked"]);
const terminalAttemptStatuses = new Set<AttemptStatus>([
  "interrupted",
  "completed",
  "failed",
  "cancelled",
]);

export const isActiveAttemptStatus = (status: AttemptStatus) => activeAttemptStatuses.has(status);
export const isTerminalAttemptStatus = (status: AttemptStatus) =>
  terminalAttemptStatuses.has(status);

export const canTransitionAttempt = (from: AttemptStatus, to: AttemptStatus) => {
  if (from === to) return true;
  switch (from) {
    case "queued":
      return to === "running" || to === "cancelled" || to === "failed";
    case "running":
      return (
        to === "waiting" ||
        to === "blocked" ||
        to === "interrupted" ||
        to === "completed" ||
        to === "failed" ||
        to === "cancelled"
      );
    case "waiting":
    case "blocked":
      return to === "running" || to === "interrupted" || to === "failed" || to === "cancelled";
    case "interrupted":
    case "completed":
    case "failed":
    case "cancelled":
      return false;
  }
};

/** A resume always creates a new attempt; terminal attempts themselves never return to running. */
export const resumeCreatesNewAttempt = (kind: InvocationKind) => kind === "resume";

/** Internal events are durable for diagnostics but are never part of the user trace projection. */
export const isUserVisibleTrace = (event: Pick<RunEvent, "visibility" | "redaction">) =>
  event.visibility !== "internal" && event.redaction !== "omitted";
