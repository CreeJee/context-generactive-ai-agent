import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Database } from "../db/database.ts";
import { JsonValue } from "../json.ts";
import type { MemoryCandidateView, MemoryUsageView } from "../memory/knowledge.ts";
import {
  ArtifactKind,
  ArtifactLocator,
  AttemptStatus,
  EvidenceLocator,
  EvidenceSourceKind,
  EvidenceVerification,
  type InvocationKind,
  RedactionState,
  ReportDisposition,
  RunEventKind,
  TaskStatus,
  TraceVisibility,
  canTransitionAttempt,
  type ArtifactLocator as ArtifactLocatorValue,
  type EvidenceLocator as EvidenceLocatorValue,
} from "./contracts.ts";

const AttemptRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  invocation_id: Schema.String,
  attempt_number: Schema.Number,
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
const RecoveryAssessment = Schema.Struct({
  checkpoint_id: Schema.NullOr(Schema.String),
  uncertain_count: Schema.Number,
  approval_count: Schema.Number,
});
const RecoveryJobRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  interrupted_attempt_id: Schema.String,
  confirm_uncertain: Schema.Number,
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
  created_at: Schema.Number,
});
const SequenceRow = Schema.Struct({ sequence: Schema.Number });
const CursorRow = Schema.Struct({ seq: Schema.Number });
const IdRow = Schema.Struct({ id: Schema.String });
const TaskIdRow = Schema.Struct({ task_id: Schema.String });
const AttemptIdRow = Schema.Struct({ attempt_id: Schema.String });
const AttemptNumberRow = Schema.Struct({ attempt_number: Schema.Number });
const LifecycleOperationRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  target_kind: Schema.Literal("task", "session"),
  target_id: Schema.String,
  intent: Schema.Literal("archive", "restore", "delete"),
  status: Schema.Literal(
    "requested",
    "cancelling",
    "waiting_for_stop",
    "purging",
    "completed",
    "blocked",
    "failed",
  ),
  idempotency_key: Schema.String,
  blocker: Schema.NullOr(Schema.String),
  requested_at: Schema.Number,
  updated_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
});
const LifecycleTaskRow = Schema.Struct({
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Number),
  delete_requested_at: Schema.NullOr(Schema.Number),
  deleted_at: Schema.NullOr(Schema.Number),
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
  latest_attempt_number: Schema.NullOr(Schema.Number),
  latest_resumed_from_attempt_id: Schema.NullOr(Schema.String),
  latest_activity: Schema.NullOr(Schema.String),
  latest_activity_at: Schema.NullOr(Schema.Number),
  archived_at: Schema.NullOr(Schema.Number),
  delete_requested_at: Schema.NullOr(Schema.Number),
  deleted_at: Schema.NullOr(Schema.Number),
  purge_receipt_id: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
  created_at: Schema.Number,
});
const AttemptViewRow = Schema.Struct({
  id: Schema.String,
  invocation_id: Schema.String,
  attempt_number: Schema.Number,
  chat_run_id: Schema.String,
  thread_id: Schema.String,
  status: AttemptStatus,
  resumed_from_attempt_id: Schema.NullOr(Schema.String),
  superseded_by_attempt_id: Schema.NullOr(Schema.String),
  resumability: Schema.String,
  started_at: Schema.NullOr(Schema.Number),
  finished_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  updated_at: Schema.Number,
});
const ResumeTaskRow = Schema.Struct({
  id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  agent_id: Schema.NullOr(Schema.String),
  request: Schema.String,
  status: Schema.String,
  active_attempt_id: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.Number),
  delete_requested_at: Schema.NullOr(Schema.Number),
  deleted_at: Schema.NullOr(Schema.Number),
  previous_attempt_id: Schema.String,
  previous_attempt_number: Schema.Number,
  previous_status: AttemptStatus,
  thread_id: Schema.String,
});
const CheckpointViewRow = Schema.Struct({
  id: Schema.String,
  attempt_id: Schema.String,
  event_sequence: Schema.Number,
  transcript_message_id: Schema.NullOr(Schema.String),
  completed_tool_call_ids: Schema.String,
  uncertain_tool_call_ids: Schema.String,
  pending_approval_ids: Schema.String,
  remaining_work: Schema.String,
  created_at: Schema.Number,
});
const CheckpointRow = Schema.Struct({
  id: Schema.String,
  completed_tool_call_ids: Schema.String,
  uncertain_tool_call_ids: Schema.String,
  pending_approval_ids: Schema.String,
  remaining_work: Schema.String,
});
const EvidenceRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
  source_kind: EvidenceSourceKind,
  locator: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  visibility: TraceVisibility,
  redaction: RedactionState,
  source_deleted_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  updated_at: Schema.Number,
});
const ArtifactRow = Schema.Struct({
  id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
  kind: ArtifactKind,
  locator: Schema.NullOr(Schema.String),
  media_type: Schema.NullOr(Schema.String),
  verification: EvidenceVerification,
  source_deleted_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  updated_at: Schema.Number,
});
const ReportAdoptionRow = Schema.Struct({
  seq: Schema.Number,
  task_id: Schema.String,
  attempt_id: Schema.String,
  disposition: ReportDisposition,
  superseded_by_attempt_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.NullOr(Schema.String),
  parent_message_id: Schema.NullOr(Schema.String),
  claim_id: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
});
const FinalAnswerClaimRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  parent_run_id: Schema.String,
  parent_message_id: Schema.String,
  created_at: Schema.Number,
});
const FinalAnswerSourceRow = Schema.Struct({
  id: Schema.String,
  claim_id: Schema.String,
  task_id: Schema.String,
  attempt_id: Schema.String,
  evidence_ref_id: Schema.NullOr(Schema.String),
});
const FinalAnswerNotificationRow = Schema.Struct({
  claim_id: Schema.String,
  notification_id: Schema.String,
  task_id: Schema.String,
});
const StoredEventRow = Schema.Struct({
  cursor: Schema.Number,
  id: Schema.String,
  origin_session_id: Schema.NullOr(Schema.String),
  task_id: Schema.String,
  invocation_id: Schema.String,
  attempt_id: Schema.String,
  attempt_sequence: Schema.Number,
  kind: RunEventKind,
  visibility: TraceVisibility,
  redaction: RedactionState,
  summary: Schema.String,
  payload: Schema.String,
  occurred_at: Schema.Number,
});
const decodeAttempt = Schema.decodeUnknownSync(AttemptRow);
const decodeRecoveryRows = Schema.decodeUnknownSync(Schema.Array(RecoveryRow));
const decodeRecoveryAssessment = Schema.decodeUnknownSync(RecoveryAssessment);
const decodeRecoveryJobRows = Schema.decodeUnknownSync(Schema.Array(RecoveryJobRow));
const decodeNotificationTask = Schema.decodeUnknownSync(NotificationTaskRow);
const decodeParentNotificationRows = Schema.decodeUnknownSync(Schema.Array(ParentNotificationRow));
const decodeSequence = Schema.decodeUnknownSync(SequenceRow);
const decodeCursor = Schema.decodeUnknownSync(CursorRow);
const decodeId = Schema.decodeUnknownSync(IdRow);
const decodeTaskId = Schema.decodeUnknownSync(TaskIdRow);
const decodeAttemptId = Schema.decodeUnknownSync(AttemptIdRow);
const decodeAttemptNumber = Schema.decodeUnknownSync(AttemptNumberRow);
const decodeLifecycleOperation = Schema.decodeUnknownSync(LifecycleOperationRow);
const decodeLifecycleTask = Schema.decodeUnknownSync(LifecycleTaskRow);
const decodeTaskViewRows = Schema.decodeUnknownSync(Schema.Array(TaskViewRow));
const decodeAttemptViewRows = Schema.decodeUnknownSync(Schema.Array(AttemptViewRow));
const decodeCheckpointViewRows = Schema.decodeUnknownSync(Schema.Array(CheckpointViewRow));
const decodeStoredEventRows = Schema.decodeUnknownSync(Schema.Array(StoredEventRow));
const decodeResumeTask = Schema.decodeUnknownSync(ResumeTaskRow);
const decodeCheckpoint = Schema.decodeUnknownSync(CheckpointRow);
const decodeEvidenceRows = Schema.decodeUnknownSync(Schema.Array(EvidenceRow));
const decodeEvidenceRow = Schema.decodeUnknownSync(EvidenceRow);
const decodeArtifactRows = Schema.decodeUnknownSync(Schema.Array(ArtifactRow));
const decodeArtifactRow = Schema.decodeUnknownSync(ArtifactRow);
const decodeReportAdoptionRows = Schema.decodeUnknownSync(Schema.Array(ReportAdoptionRow));
const decodeFinalAnswerClaimRows = Schema.decodeUnknownSync(Schema.Array(FinalAnswerClaimRow));
const decodeFinalAnswerSourceRows = Schema.decodeUnknownSync(Schema.Array(FinalAnswerSourceRow));
const decodeFinalAnswerNotificationRows = Schema.decodeUnknownSync(
  Schema.Array(FinalAnswerNotificationRow),
);
const decodeEvidenceLocator = Schema.decodeUnknownSync(Schema.parseJson(EvidenceLocator));
const decodeArtifactLocator = Schema.decodeUnknownSync(Schema.parseJson(ArtifactLocator));
const decodeStringArray = Schema.decodeUnknownSync(Schema.parseJson(Schema.Array(Schema.String)));
const decodePayload = Schema.decodeUnknownSync(Schema.parseJson(JsonValue));

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
  readonly latestActivity: string | null;
  readonly latestActivityAt: number | null;
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
  readonly resumability: JsonValue;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TraceTreeSnapshot {
  readonly cursor: number;
  readonly tasks: readonly TraceTaskView[];
}

export interface TraceTaskDetail {
  readonly task: TraceTaskView;
  readonly attempts: readonly TraceAttemptView[];
  readonly checkpoints: readonly TraceCheckpointView[];
  readonly evidence: readonly TraceEvidenceView[];
  readonly artifacts: readonly TraceArtifactView[];
  readonly adoptions: readonly TraceReportAdoptionView[];
  readonly answerClaims: readonly TraceFinalAnswerClaimView[];
  /** Present on HTTP detail projections; omitted by the lower-level trace store. */
  readonly memoryCandidates?: readonly MemoryCandidateView[];
  /** Retrieval and actual-use events are separate so recall does not imply answer influence. */
  readonly memoryUsage?: readonly MemoryUsageView[];
  readonly events: readonly TraceEventView[];
}

export interface TraceReportAdoptionView {
  readonly sequence: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly disposition: ReportDisposition;
  readonly supersededByAttemptId: string | null;
  readonly parentRunId: string | null;
  readonly parentMessageId: string | null;
  readonly claimId: string | null;
  readonly updatedAt: number;
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
    readonly evidenceRefId: string | null;
  }[];
  readonly notificationIds: readonly string[];
  readonly createdAt: number;
}

export interface TraceEvidenceView {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sourceKind: EvidenceSourceKind;
  /** Null for redacted user projections and source-deleted tombstones. */
  readonly locator: EvidenceLocatorValue | null;
  readonly verification: EvidenceVerification;
  readonly visibility: TraceVisibility;
  readonly redaction: RedactionState;
  readonly sourceDeletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface TraceCheckpointView {
  readonly id: string;
  readonly attemptId: string;
  readonly eventSequence: number;
  readonly transcriptMessageId: string | null;
  readonly completedToolCallIds: readonly string[];
  readonly uncertainToolCallIds: readonly string[];
  readonly pendingApprovalIds: readonly string[];
  readonly remainingWork: string;
  readonly createdAt: number;
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

export interface ResumeContext {
  readonly originalRequest: string;
  readonly remainingWork: string;
  readonly completedToolCallIds: readonly string[];
  readonly uncertainToolCallIds: readonly string[];
  readonly expiredApprovalIds: readonly string[];
  readonly checkpointId: string;
}

export type ResumeClaim =
  | {
      readonly status: "started";
      readonly handle: AttemptHandle;
      readonly agentId: string;
      readonly context: ResumeContext;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "task_not_found"
        | "task_archived"
        | "task_deleted"
        | "attempt_alive"
        | "task_terminal"
        | "missing_checkpoint"
        | "uncertain_side_effect"
        | "stale_attempt"
        | "origin_deleted"
        | "agent_deleted";
    };

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
  readonly agentId: string;
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

export interface CheckpointInput {
  readonly handle: AttemptHandle;
  readonly transcriptMessageId?: string | null;
  readonly completedToolCallIds: readonly string[];
  readonly uncertainToolCallIds: readonly string[];
  readonly pendingApprovalIds: readonly string[];
  readonly remainingWork: string;
}

export interface RecordEvidenceInput {
  readonly handle: AttemptHandle;
  readonly locator: EvidenceLocatorValue;
  readonly verification?: Exclude<EvidenceVerification, "source_deleted">;
  readonly visibility?: TraceVisibility;
  readonly redaction?: RedactionState;
}

export interface RecordArtifactInput {
  readonly handle: AttemptHandle;
  readonly kind: ArtifactKind;
  readonly locator: ArtifactLocatorValue;
  readonly mediaType?: string | null;
  readonly verification?: Exclude<EvidenceVerification, "source_deleted">;
}

const taskStatusForAttempt = (status: AttemptStatus): TaskStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "resumable";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;

  const assertHandle = (handle: AttemptHandle) => {
    const found = sqlite
      .prepare(
        `SELECT 1 FROM agent_run_attempts
         WHERE id = ? AND task_id = ? AND invocation_id = ? AND chat_run_id = ? AND thread_id = ?`,
      )
      .get(handle.id, handle.taskId, handle.invocationId, handle.chatRunId, handle.threadId);
    if (!found) throw new Error("Evidence AttemptHandle does not match a durable attempt");
  };
  const assertSafeFile = (locator: { readonly path: string; readonly sha256: string }) => {
    if (
      locator.path.length === 0 ||
      locator.path.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(locator.path) ||
      locator.path.split(/[\\/]/).includes("..")
    )
      throw new Error("Evidence file paths must be project-relative and normalized");
    if (!/^[a-f\d]{64}$/i.test(locator.sha256))
      throw new Error("Evidence file locators require a sha256 digest");
  };
  const evidenceView = (row: typeof EvidenceRow.Type): TraceEvidenceView => ({
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    sourceKind: row.source_kind,
    locator:
      row.locator === null || row.redaction === "redacted"
        ? null
        : decodeEvidenceLocator(row.locator),
    verification: row.verification,
    visibility: row.visibility,
    redaction: row.redaction,
    sourceDeletedAt: row.source_deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const artifactView = (row: typeof ArtifactRow.Type): TraceArtifactView => ({
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    locator: row.locator === null ? null : decodeArtifactLocator(row.locator),
    mediaType: row.media_type,
    verification: row.verification,
    sourceDeletedAt: row.source_deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const recordEvidence = (input: RecordEvidenceInput): TraceEvidenceView =>
    atomic(() => {
      assertHandle(input.handle);
      const locator = Schema.decodeUnknownSync(EvidenceLocator)(input.locator);
      if (locator.kind !== input.locator.kind)
        throw new Error("Evidence locator kind changed during decoding");
      if (locator.kind === "file") assertSafeFile(locator);
      if (
        (locator.kind === "message" ||
          locator.kind === "tool_call" ||
          locator.kind === "tool_result") &&
        locator.threadId !== input.handle.threadId
      )
        throw new Error("Evidence locator belongs to another thread");
      if (
        locator.kind === "checkpoint" &&
        !sqlite
          .prepare("SELECT 1 FROM work_checkpoints WHERE id = ? AND attempt_id = ? AND task_id = ?")
          .get(locator.checkpointId, input.handle.id, input.handle.taskId)
      )
        throw new Error("Evidence checkpoint does not belong to this attempt");
      if (
        locator.kind === "artifact" &&
        !sqlite
          .prepare("SELECT 1 FROM work_artifacts WHERE id = ? AND task_id = ?")
          .get(locator.artifactId, input.handle.taskId)
      )
        throw new Error("Evidence artifact does not belong to this task");
      const sourceKind = locator.kind;
      const encoded = JSON.stringify(locator);
      const existing = sqlite
        .prepare(
          `SELECT * FROM evidence_refs
           WHERE attempt_id = ? AND source_kind = ? AND locator = ?`,
        )
        .get(input.handle.id, sourceKind, encoded);
      if (existing) return evidenceView(decodeEvidenceRow(existing));
      const now = Date.now();
      return evidenceView(
        decodeEvidenceRow(
          sqlite
            .prepare(
              `INSERT INTO evidence_refs
               (id, task_id, attempt_id, source_kind, locator, verification, visibility,
                redaction, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(
              randomUUID(),
              input.handle.taskId,
              input.handle.id,
              sourceKind,
              encoded,
              input.verification ?? "unverified",
              input.visibility ?? "summary",
              input.redaction ?? "clear",
              now,
              now,
            ),
        ),
      );
    });

  const setEvidenceVerification = (
    evidenceId: string,
    verification: Exclude<EvidenceVerification, "source_deleted">,
  ): TraceEvidenceView | null =>
    atomic(() => {
      const row = sqlite
        .prepare(
          `UPDATE evidence_refs SET verification = ?, source_deleted_at = NULL, updated_at = ?
           WHERE id = ? AND locator IS NOT NULL RETURNING *`,
        )
        .get(verification, Date.now(), evidenceId);
      return row ? evidenceView(decodeEvidenceRow(row)) : null;
    });

  const markEvidenceSourceDeleted = (evidenceId: string): TraceEvidenceView | null =>
    atomic(() => {
      const now = Date.now();
      const row = sqlite
        .prepare(
          `UPDATE evidence_refs
           SET locator = NULL, verification = 'source_deleted', redaction = 'redacted',
               source_deleted_at = ?, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(now, now, evidenceId);
      return row ? evidenceView(decodeEvidenceRow(row)) : null;
    });

  const recordArtifact = (input: RecordArtifactInput): TraceArtifactView =>
    atomic(() => {
      assertHandle(input.handle);
      const locator = Schema.decodeUnknownSync(ArtifactLocator)(input.locator);
      if (locator.kind !== input.kind) throw new Error("Artifact kind must match its locator");
      if (locator.kind === "file") assertSafeFile(locator);
      const encoded = JSON.stringify(locator);
      const existing = sqlite
        .prepare("SELECT * FROM work_artifacts WHERE attempt_id = ? AND kind = ? AND locator = ?")
        .get(input.handle.id, input.kind, encoded);
      if (existing) return artifactView(decodeArtifactRow(existing));
      const now = Date.now();
      return artifactView(
        decodeArtifactRow(
          sqlite
            .prepare(
              `INSERT INTO work_artifacts
               (id, task_id, attempt_id, kind, locator, media_type, verification,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(
              randomUUID(),
              input.handle.taskId,
              input.handle.id,
              input.kind,
              encoded,
              input.mediaType ?? null,
              input.verification ?? "unverified",
              now,
              now,
            ),
        ),
      );
    });

  const setArtifactVerification = (
    artifactId: string,
    verification: Exclude<EvidenceVerification, "source_deleted">,
  ): TraceArtifactView | null =>
    atomic(() => {
      const row = sqlite
        .prepare(
          `UPDATE work_artifacts SET verification = ?, source_deleted_at = NULL, updated_at = ?
           WHERE id = ? AND locator IS NOT NULL RETURNING *`,
        )
        .get(verification, Date.now(), artifactId);
      return row ? artifactView(decodeArtifactRow(row)) : null;
    });

  const markArtifactSourceDeleted = (artifactId: string): TraceArtifactView | null =>
    atomic(() => {
      const now = Date.now();
      const row = sqlite
        .prepare(
          `UPDATE work_artifacts
           SET locator = NULL, media_type = NULL, verification = 'source_deleted',
               source_deleted_at = ?, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(now, now, artifactId);
      return row ? artifactView(decodeArtifactRow(row)) : null;
    });

  const recover = atomic(() => {
    const now = Date.now();
    const attempts = decodeRecoveryRows(
      sqlite
        .prepare(
          `SELECT a.id, a.task_id, t.project_id, t.origin_session_id, t.agent_id,
                  t.parent_run_id
           FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
           WHERE a.status IN ('queued', 'running', 'waiting', 'blocked')`,
        )
        .all(),
    );
    const assess = sqlite.prepare(
      `SELECT c.id AS checkpoint_id,
              coalesce(json_array_length(c.uncertain_tool_call_ids), 0) AS uncertain_count,
              coalesce(json_array_length(c.pending_approval_ids), 0) AS approval_count
       FROM work_checkpoints c WHERE c.attempt_id = ?
       ORDER BY c.event_sequence DESC LIMIT 1`,
    );
    const markAttempt = sqlite.prepare(
      `UPDATE agent_run_attempts
       SET status = 'interrupted', resume_reason = 'server_restarted',
           resumability = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    const markTask = sqlite.prepare(
      `UPDATE work_tasks SET status = ?, active_attempt_id = NULL, updated_at = ? WHERE id = ?`,
    );
    const insertRecovery = sqlite.prepare(
      `INSERT INTO work_recovery_jobs
       (id, project_id, task_id, interrupted_attempt_id, status, blocker, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO NOTHING`,
    );
    const insertNotification = sqlite.prepare(
      `INSERT INTO parent_notifications
       (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
        idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'interrupted', ?, '{}', ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    );
    for (const row of attempts) {
      const assessmentRow = assess.get(row.id);
      const assessment = assessmentRow
        ? decodeRecoveryAssessment(assessmentRow)
        : { checkpoint_id: null, uncertain_count: 0, approval_count: 0 };
      const blocker =
        row.origin_session_id === null
          ? "origin_deleted"
          : row.agent_id === null
            ? "agent_deleted"
            : assessment.checkpoint_id === null
              ? "missing_checkpoint"
              : assessment.uncertain_count > 0
                ? "uncertain_side_effect"
                : assessment.approval_count > 0
                  ? "approval_expired"
                  : null;
      const safe = blocker === null;
      markAttempt.run(
        JSON.stringify(
          safe
            ? { state: "logical_resume", reason: "server_restarted", blockers: [] }
            : { state: "blocked", reason: "server_restarted", blockers: [blocker] },
        ),
        now,
        now,
        row.id,
      );
      markTask.run(safe ? "resumable" : "blocked", now, row.task_id);
      insertRecovery.run(
        randomUUID(),
        row.project_id,
        row.task_id,
        row.id,
        safe ? "queued" : "blocked",
        blocker,
        now,
        now,
      );
      insertNotification.run(
        randomUUID(),
        row.project_id,
        row.task_id,
        row.origin_session_id,
        row.parent_run_id,
        safe
          ? "Subagent execution was interrupted and queued for safe recovery."
          : `Subagent execution was interrupted; recovery is blocked by ${blocker}.`,
        `recovery:${row.id}:interrupted`,
        now,
      );
    }
    return attempts.length;
  });

  const listeners = new Set<(sessionId: string, cursor: number) => void>();
  const appendEvent = (input: AppendEventInput) => {
    const event = atomic(() => {
      const next = decodeSequence(
        sqlite
          .prepare(
            `SELECT coalesce(max(attempt_sequence), 0) + 1 AS sequence
             FROM run_events WHERE attempt_id = ?`,
          )
          .get(input.handle.id),
      );
      const occurredAt = input.occurredAt ?? Date.now();
      const id = randomUUID();
      const row = decodeCursor(
        sqlite
          .prepare(
            `INSERT INTO run_events
             (id, origin_session_id, task_id, invocation_id, attempt_id, attempt_sequence, kind,
              visibility, redaction, summary, payload, occurred_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING seq`,
          )
          .get(
            id,
            input.sessionId,
            input.handle.taskId,
            input.handle.invocationId,
            input.handle.id,
            next.sequence,
            input.kind,
            input.visibility ?? "summary",
            input.redaction ?? "clear",
            input.summary,
            JSON.stringify(input.payload ?? {}),
            occurredAt,
          ),
      );
      return { id, cursor: row.seq, attemptSequence: next.sequence, occurredAt };
    });
    for (const listener of listeners) listener(input.sessionId, event.cursor);
    return event;
  };

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
    atomic(() => {
      const task = decodeNotificationTask(
        sqlite
          .prepare(
            `SELECT project_id, origin_session_id, parent_run_id FROM work_tasks WHERE id = ?`,
          )
          .get(input.taskId),
      );
      const now = Date.now();
      const id = randomUUID();
      const result = sqlite
        .prepare(
          `INSERT INTO parent_notifications
           (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
            idempotency_key, delivered_to_run_id, delivered_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          id,
          task.project_id,
          input.taskId,
          task.origin_session_id,
          task.parent_run_id,
          input.kind,
          input.summary,
          JSON.stringify(input.payload ?? {}),
          input.idempotencyKey,
          input.deliveredImmediately ? (input.deliveredToRunId ?? task.parent_run_id) : null,
          input.deliveredImmediately ? now : null,
          now,
        );
      return result.changes === 1 ? id : null;
    });

  const releaseParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    sqlite
      .prepare(
        `UPDATE parent_notifications SET delivered_to_run_id = NULL, delivered_at = NULL
         WHERE origin_session_id = ? AND delivered_to_run_id = ?`,
      )
      .run(sessionId, deliveredToRunId).changes;

  const consumeParentNotifications = (sessionId: string, deliveredToRunId: string) =>
    atomic(() => {
      const rows = decodeParentNotificationRows(
        sqlite
          .prepare(
            `SELECT id, task_id, kind, summary, payload, created_at
             FROM parent_notifications
             WHERE origin_session_id = ? AND delivered_at IS NULL ORDER BY seq`,
          )
          .all(sessionId),
      );
      if (rows.length === 0) return [];
      const now = Date.now();
      const deliver = sqlite.prepare(
        `UPDATE parent_notifications SET delivered_to_run_id = ?, delivered_at = ?
         WHERE id = ? AND delivered_at IS NULL`,
      );
      const delivered: ParentNotificationView[] = [];
      for (const row of rows) {
        if (deliver.run(deliveredToRunId, now, row.id).changes !== 1) continue;
        delivered.push({
          id: row.id,
          taskId: row.task_id,
          kind: row.kind,
          summary: row.summary,
          payload: decodePayload(row.payload),
          createdAt: row.created_at,
        });
      }
      return delivered;
    });

  const startAttempt = (input: StartAttemptInput): AttemptHandle =>
    atomic(() => {
      const now = Date.now();
      const taskId = randomUUID();
      const invocationId = randomUUID();
      const attemptId = randomUUID();
      const chatRunId = randomUUID();
      const previousAttempt = input.resumedFromAttemptId
        ? sqlite
            .prepare("SELECT attempt_number FROM agent_run_attempts WHERE id = ?")
            .get(input.resumedFromAttemptId)
        : undefined;
      const attemptNumber = previousAttempt
        ? decodeAttemptNumber(previousAttempt).attempt_number + 1
        : 1;
      const insertedTask = sqlite
        .prepare(
          `INSERT INTO work_tasks
           (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_id,
            agent_name, status, title, request, active_attempt_id, created_at, updated_at)
           SELECT ?, s.project_id, s.id, ?, ?, a.id, coalesce(a.name, 'subagent'),
                  'queued', ?, ?, NULL, ?, ?
           FROM sessions s JOIN subagents a ON a.session_id = s.id
           WHERE s.id = ? AND a.id = ?`,
        )
        .run(
          taskId,
          input.parentRunId,
          input.parentToolCallId,
          input.title,
          input.request,
          now,
          now,
          input.sessionId,
          input.agentId,
        );
      if (insertedTask.changes !== 1)
        throw new Error("Work Trace origin session or subagent no longer exists");
      sqlite
        .prepare(
          `INSERT INTO agent_invocations
           (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
            target_attempt_id, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
        )
        .run(
          invocationId,
          taskId,
          input.parentRunId,
          input.parentToolCallId,
          input.kind,
          input.request,
          input.resumedFromAttemptId ?? null,
          `${input.parentRunId}:${input.parentToolCallId}`,
          now,
        );
      sqlite
        .prepare(
          `INSERT INTO agent_run_attempts
           (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
            resumed_from_attempt_id, resume_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          taskId,
          invocationId,
          attemptNumber,
          chatRunId,
          input.threadId,
          input.resumedFromAttemptId ?? null,
          input.resumeReason ?? null,
          now,
          now,
        );
      sqlite
        .prepare("UPDATE work_tasks SET active_attempt_id = ? WHERE id = ?")
        .run(attemptId, taskId);
      const handle = {
        id: attemptId,
        taskId,
        invocationId,
        chatRunId,
        threadId: input.threadId,
        attemptNumber,
      };
      appendEvent({
        handle,
        sessionId: input.sessionId,
        kind: input.kind === "resume" ? "resume_requested" : "attempt_queued",
        summary: input.kind === "resume" ? "Resume requested" : "Task queued",
        occurredAt: now,
      });
      return handle;
    });

  const recordSteer = (input: {
    readonly handle: AttemptHandle;
    readonly sessionId: string;
    readonly parentRunId: string;
    readonly parentToolCallId: string;
    readonly message: string;
  }) =>
    atomic(() => {
      const id = randomUUID();
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO agent_invocations
           (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
            target_attempt_id, idempotency_key, created_at, finished_at)
           VALUES (?, ?, ?, ?, 'steer', 'steered', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.handle.taskId,
          input.parentRunId,
          input.parentToolCallId,
          input.message,
          input.handle.id,
          `${input.parentRunId}:${input.parentToolCallId}`,
          now,
          now,
        );
      const steerHandle = { ...input.handle, invocationId: id };
      appendEvent({
        handle: steerHandle,
        sessionId: input.sessionId,
        kind: "steered",
        summary: "Additional instructions delivered",
        occurredAt: now,
      });
      return id;
    });

  const transitionAttempt = (
    handle: AttemptHandle,
    sessionId: string,
    status: AttemptStatus,
    event: RunEventKind,
    summary: string,
    error?: string | null,
    deliveredImmediately = true,
    deliveredToRunId?: string,
  ) =>
    atomic(() => {
      const current = decodeAttempt(
        sqlite.prepare("SELECT * FROM agent_run_attempts WHERE id = ?").get(handle.id),
      );
      const from = current.status;
      if (!canTransitionAttempt(from, status))
        throw new Error(`Invalid attempt transition ${from} -> ${status}`);
      const now = Date.now();
      const terminal = ["interrupted", "completed", "failed", "cancelled"].includes(status);
      sqlite
        .prepare(
          `UPDATE agent_run_attempts
           SET status = ?, started_at = coalesce(started_at, ?), finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(status, now, terminal ? now : null, now, handle.id);
      sqlite
        .prepare(
          `UPDATE work_tasks SET status = ?, active_attempt_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(taskStatusForAttempt(status), terminal ? null : handle.id, now, handle.taskId);
      sqlite
        .prepare(`UPDATE agent_invocations SET status = ?, finished_at = ? WHERE id = ?`)
        .run(
          status === "completed"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : status === "failed" || status === "interrupted"
                ? "failed"
                : "running",
          terminal ? now : null,
          handle.invocationId,
        );
      const appended = appendEvent({
        handle,
        sessionId,
        kind: event,
        summary,
        payload: error ? { error } : {},
        occurredAt: now,
      });
      const notificationKind =
        status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "stopped"
              : status === "interrupted"
                ? "interrupted"
                : status === "running" && handle.attemptNumber > 1
                  ? "resumed"
                  : null;
      if (notificationKind)
        notifyParent({
          taskId: handle.taskId,
          kind: notificationKind,
          summary,
          idempotencyKey: `attempt:${handle.id}:${notificationKind}`,
          deliveredImmediately,
          deliveredToRunId,
        });
      return appended;
    });

  const checkpoint = (sessionId: string, input: CheckpointInput) =>
    atomic(() => {
      const event = appendEvent({
        handle: input.handle,
        sessionId,
        kind: "checkpoint_created",
        summary: "Checkpoint saved",
      });
      const id = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO work_checkpoints
           (id, task_id, attempt_id, event_sequence, transcript_message_id,
            completed_tool_call_ids, uncertain_tool_call_ids, pending_approval_ids,
            remaining_work, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.handle.taskId,
          input.handle.id,
          event.attemptSequence,
          input.transcriptMessageId ?? null,
          JSON.stringify(input.completedToolCallIds),
          JSON.stringify(input.uncertainToolCallIds),
          JSON.stringify(input.pendingApprovalIds),
          input.remainingWork,
          event.occurredAt,
        );
      return { checkpointId: id, ...event };
    });

  const evidenceForTask = (taskId: string): TraceEvidenceView[] =>
    decodeEvidenceRows(
      sqlite
        .prepare(
          `SELECT * FROM evidence_refs
           WHERE task_id = ? AND visibility <> 'internal' AND redaction <> 'omitted'
           ORDER BY created_at, id`,
        )
        .all(taskId),
    ).map(evidenceView);

  const artifactsForTask = (taskId: string): TraceArtifactView[] =>
    decodeArtifactRows(
      sqlite
        .prepare("SELECT * FROM work_artifacts WHERE task_id = ? ORDER BY created_at, id")
        .all(taskId),
    ).map(artifactView);

  const evidenceIdsForAttempt = (attemptId: string) =>
    decodeEvidenceRows(
      sqlite
        .prepare(
          `SELECT * FROM evidence_refs WHERE attempt_id = ? AND verification = 'verified'
             AND visibility <> 'internal' AND redaction <> 'omitted'
           ORDER BY created_at, id`,
        )
        .all(attemptId),
    ).map((row) => row.id);

  const reportAdoptionsForTask = (taskId: string): TraceReportAdoptionView[] =>
    decodeReportAdoptionRows(
      sqlite
        .prepare(
          `SELECT seq, task_id, attempt_id, disposition, superseded_by_attempt_id,
                  parent_run_id, parent_message_id, claim_id, updated_at
           FROM report_adoptions WHERE task_id = ? ORDER BY seq`,
        )
        .all(taskId),
    ).map((row) => ({
      sequence: row.seq,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      disposition: row.disposition,
      supersededByAttemptId: row.superseded_by_attempt_id,
      parentRunId: row.parent_run_id,
      parentMessageId: row.parent_message_id,
      claimId: row.claim_id,
      updatedAt: row.updated_at,
    }));

  const answerClaimsForTask = (taskId: string): TraceFinalAnswerClaimView[] => {
    const claims = decodeFinalAnswerClaimRows(
      sqlite
        .prepare(
          `SELECT DISTINCT c.id, c.project_id, c.origin_session_id, c.parent_run_id,
                           c.parent_message_id, c.created_at
           FROM final_answer_claims c
           WHERE EXISTS (SELECT 1 FROM final_answer_sources s
                         WHERE s.claim_id = c.id AND s.task_id = ?)
              OR EXISTS (SELECT 1 FROM final_answer_notifications n
                         WHERE n.claim_id = c.id AND n.task_id = ?)
           ORDER BY c.created_at, c.id`,
        )
        .all(taskId, taskId),
    );
    const sources = sqlite.prepare(
      `SELECT id, claim_id, task_id, attempt_id, evidence_ref_id
       FROM final_answer_sources WHERE claim_id = ? ORDER BY task_id, attempt_id, evidence_ref_id`,
    );
    const notifications = sqlite.prepare(
      `SELECT claim_id, notification_id, task_id FROM final_answer_notifications
       WHERE claim_id = ? ORDER BY notification_id`,
    );
    return claims.map((claim) => ({
      id: claim.id,
      projectId: claim.project_id,
      originSessionId: claim.origin_session_id,
      parentRunId: claim.parent_run_id,
      parentMessageId: claim.parent_message_id,
      sources: decodeFinalAnswerSourceRows(sources.all(claim.id)).map((source) => ({
        taskId: source.task_id,
        attemptId: source.attempt_id,
        evidenceRefId: source.evidence_ref_id,
      })),
      notificationIds: decodeFinalAnswerNotificationRows(notifications.all(claim.id)).map(
        (notification) => notification.notification_id,
      ),
      createdAt: claim.created_at,
    }));
  };

  const recordReportDisposition = (input: {
    readonly handle: AttemptHandle;
    readonly sessionId: string;
    readonly disposition: ReportDisposition;
    readonly parentRunId?: string | null;
    readonly parentMessageId?: string | null;
    readonly claimId?: string | null;
    readonly supersededByAttemptId?: string | null;
  }) => {
    assertHandle(input.handle);
    if ((input.disposition === "superseded") !== Boolean(input.supersededByAttemptId))
      throw new Error("Only superseded reports require a superseding attempt");
    if (
      input.supersededByAttemptId &&
      !sqlite
        .prepare("SELECT 1 FROM agent_run_attempts WHERE id = ? AND task_id = ?")
        .get(input.supersededByAttemptId, input.handle.taskId)
    )
      throw new Error("Superseding attempt belongs to another task");
    const existing = sqlite
      .prepare(
        `SELECT seq FROM report_adoptions
         WHERE task_id = ? AND attempt_id = ? AND disposition = ?
           AND parent_run_id IS ? AND parent_message_id IS ? AND claim_id IS ?
           AND superseded_by_attempt_id IS ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(
        input.handle.taskId,
        input.handle.id,
        input.disposition,
        input.parentRunId ?? null,
        input.parentMessageId ?? null,
        input.claimId ?? null,
        input.supersededByAttemptId ?? null,
      );
    if (existing) return decodeCursor(existing).seq;
    return atomic(() => {
      const now = Date.now();
      const result = sqlite
        .prepare(
          `INSERT INTO report_adoptions
           (task_id, attempt_id, disposition, superseded_by_attempt_id, updated_at,
            parent_run_id, parent_message_id, claim_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.handle.taskId,
          input.handle.id,
          input.disposition,
          input.supersededByAttemptId ?? null,
          now,
          input.parentRunId ?? null,
          input.parentMessageId ?? null,
          input.claimId ?? null,
        );
      appendEvent({
        handle: input.handle,
        sessionId: input.sessionId,
        kind: `report_${input.disposition}`,
        summary: `Subagent report ${input.disposition.replace("_", " ")}`,
        payload: input.claimId ? { claimId: input.claimId } : {},
      });
      return Number(result.lastInsertRowid);
    });
  };

  const finalizeAnswerClaim = (input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly parentRunId: string;
    readonly parentMessageId: string;
    readonly usedReports: readonly {
      readonly taskId: string;
      readonly attemptId: string;
      readonly evidenceRefIds: readonly string[];
    }[];
    readonly reflectedNotificationIds: readonly string[];
  }) => {
    const existing = sqlite
      .prepare(
        "SELECT id FROM final_answer_claims WHERE parent_run_id = ? AND parent_message_id = ?",
      )
      .get(input.parentRunId, input.parentMessageId);
    if (existing) return decodeId(existing).id;
    const session = sqlite
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND project_id = ?")
      .get(input.sessionId, input.projectId);
    if (!session) throw new Error("Final answer session does not belong to the project");
    const reviewed = decodeReportAdoptionRows(
      sqlite
        .prepare(
          `SELECT a.seq, a.task_id, a.attempt_id, a.disposition, a.superseded_by_attempt_id,
                  a.parent_run_id, a.parent_message_id, a.claim_id, a.updated_at
           FROM report_adoptions a JOIN work_tasks t ON t.id = a.task_id
           WHERE a.parent_run_id = ? AND a.disposition = 'reviewed'
             AND t.project_id = ? AND t.origin_session_id = ?
           ORDER BY a.seq`,
        )
        .all(input.parentRunId, input.projectId, input.sessionId),
    );
    const reviewedKeys = new Set(reviewed.map((row) => `${row.task_id}:${row.attempt_id}`));
    const selected = new Map(
      input.usedReports.map((report) => [`${report.taskId}:${report.attemptId}`, report] as const),
    );
    for (const [key, report] of selected) {
      if (!reviewedKeys.has(key)) throw new Error("Final answer selected an unreviewed report");
      for (const evidenceId of report.evidenceRefIds)
        if (
          !sqlite
            .prepare(
              `SELECT 1 FROM evidence_refs
               WHERE id = ? AND task_id = ? AND attempt_id = ? AND verification = 'verified'`,
            )
            .get(evidenceId, report.taskId, report.attemptId)
        )
          throw new Error("Final answer selected unavailable or unrelated evidence");
    }
    const notificationTasks = new Map<string, string>();
    for (const notificationId of input.reflectedNotificationIds) {
      const row = sqlite
        .prepare(
          `SELECT n.task_id FROM parent_notifications n
           JOIN work_tasks t ON t.id = n.task_id
           WHERE n.id = ? AND n.origin_session_id = ? AND n.delivered_to_run_id = ?
             AND t.project_id = ?`,
        )
        .get(notificationId, input.sessionId, input.parentRunId, input.projectId);
      if (!row) throw new Error("Final answer selected an undelivered parent notification");
      notificationTasks.set(notificationId, decodeTaskId(row).task_id);
    }

    const claimId = randomUUID();
    const now = Date.now();
    const eventInputs: {
      handle: AttemptHandle;
      disposition: "used" | "not_used" | "superseded";
    }[] = [];
    atomic(() => {
      sqlite
        .prepare(
          `INSERT INTO final_answer_claims
           (id, project_id, origin_session_id, parent_run_id, parent_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claimId,
          input.projectId,
          input.sessionId,
          input.parentRunId,
          input.parentMessageId,
          now,
        );
      const addSource = sqlite.prepare(
        `INSERT INTO final_answer_sources (id, claim_id, task_id, attempt_id, evidence_ref_id)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const report of selected.values()) {
        const ids = [...new Set(report.evidenceRefIds)];
        if (ids.length === 0)
          addSource.run(randomUUID(), claimId, report.taskId, report.attemptId, null);
        else
          for (const id of ids)
            addSource.run(randomUUID(), claimId, report.taskId, report.attemptId, id);
      }
      const addNotification = sqlite.prepare(
        `INSERT INTO final_answer_notifications (claim_id, notification_id, task_id)
         VALUES (?, ?, ?)`,
      );
      for (const [id, taskId] of notificationTasks) addNotification.run(claimId, id, taskId);

      const findHandle = sqlite.prepare(
        `SELECT id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status
         FROM agent_run_attempts WHERE id = ? AND task_id = ?`,
      );
      for (const row of reviewed) {
        const attempt = decodeAttempt(findHandle.get(row.attempt_id, row.task_id));
        const disposition = selected.has(`${row.task_id}:${row.attempt_id}`) ? "used" : "not_used";
        sqlite
          .prepare(
            `INSERT INTO report_adoptions
             (task_id, attempt_id, disposition, superseded_by_attempt_id, updated_at,
              parent_run_id, parent_message_id, claim_id)
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .run(
            row.task_id,
            row.attempt_id,
            disposition,
            now,
            input.parentRunId,
            input.parentMessageId,
            claimId,
          );
        eventInputs.push({
          handle: {
            id: attempt.id,
            taskId: attempt.task_id,
            invocationId: attempt.invocation_id,
            chatRunId: attempt.chat_run_id,
            threadId: attempt.thread_id,
            attemptNumber: attempt.attempt_number,
          },
          disposition,
        });
      }
      for (const report of selected.values()) {
        const priorRow = sqlite
          .prepare(
            `SELECT attempt_id FROM report_adoptions
             WHERE task_id = ? AND disposition = 'used' AND attempt_id <> ?
             ORDER BY seq DESC LIMIT 1`,
          )
          .get(report.taskId, report.attemptId);
        if (priorRow) {
          const prior = decodeAttemptId(priorRow);
          sqlite
            .prepare(
              `INSERT INTO report_adoptions
               (task_id, attempt_id, disposition, superseded_by_attempt_id, updated_at,
                parent_run_id, parent_message_id, claim_id)
               VALUES (?, ?, 'superseded', ?, ?, ?, ?, ?)`,
            )
            .run(
              report.taskId,
              prior.attempt_id,
              report.attemptId,
              now,
              input.parentRunId,
              input.parentMessageId,
              claimId,
            );
          const priorAttempt = decodeAttempt(findHandle.get(prior.attempt_id, report.taskId));
          eventInputs.push({
            handle: {
              id: priorAttempt.id,
              taskId: priorAttempt.task_id,
              invocationId: priorAttempt.invocation_id,
              chatRunId: priorAttempt.chat_run_id,
              threadId: priorAttempt.thread_id,
              attemptNumber: priorAttempt.attempt_number,
            },
            disposition: "superseded",
          });
        }
      }
      for (const event of eventInputs)
        appendEvent({
          handle: event.handle,
          sessionId: input.sessionId,
          kind: `report_${event.disposition}`,
          summary: `Subagent report ${event.disposition.replace("_", " ")}`,
          payload: { claimId, parentMessageId: input.parentMessageId },
        });
    });
    return claimId;
  };

  const taskTree = (sessionId: string): TraceTaskView[] =>
    decodeTaskViewRows(
      sqlite
        .prepare(
          `SELECT t.id, t.project_id, t.origin_session_id, t.parent_task_id,
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
                  e.summary AS latest_activity, e.occurred_at AS latest_activity_at,
                  t.archived_at, t.delete_requested_at, t.deleted_at, t.purge_receipt_id,
                  t.updated_at, t.created_at
           FROM work_tasks t
           LEFT JOIN agent_run_attempts a ON a.id =
             (SELECT latest.id FROM agent_run_attempts latest
              WHERE latest.task_id = t.id ORDER BY latest.attempt_number DESC LIMIT 1)
           LEFT JOIN run_events e ON e.seq =
             (SELECT latest_event.seq FROM run_events latest_event
              WHERE latest_event.task_id = t.id AND latest_event.visibility <> 'internal'
                AND latest_event.redaction <> 'omitted'
              ORDER BY latest_event.seq DESC LIMIT 1)
           WHERE t.origin_session_id = ? ORDER BY t.created_at, t.id`,
        )
        .all(sessionId),
    ).map((row) => ({
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
      latestActivity: row.latest_activity,
      latestActivityAt: row.latest_activity_at,
      archivedAt: row.archived_at,
      deleteRequestedAt: row.delete_requested_at,
      deletedAt: row.deleted_at,
      purgeReceiptId: row.purge_receipt_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

  /** Project-owned review projection, including tasks whose origin session was deleted. */
  const projectTaskTree = (projectId: string): TraceTaskView[] =>
    decodeTaskViewRows(
      sqlite
        .prepare(
          `SELECT t.id, t.project_id, t.origin_session_id, t.parent_task_id,
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
                  e.summary AS latest_activity, e.occurred_at AS latest_activity_at,
                  t.archived_at, t.delete_requested_at, t.deleted_at, t.purge_receipt_id,
                  t.updated_at, t.created_at
           FROM work_tasks t
           LEFT JOIN agent_run_attempts a ON a.id =
             (SELECT latest.id FROM agent_run_attempts latest
              WHERE latest.task_id = t.id ORDER BY latest.attempt_number DESC LIMIT 1)
           LEFT JOIN run_events e ON e.seq =
             (SELECT latest_event.seq FROM run_events latest_event
              WHERE latest_event.task_id = t.id AND latest_event.visibility <> 'internal'
                AND latest_event.redaction <> 'omitted'
              ORDER BY latest_event.seq DESC LIMIT 1)
           WHERE t.project_id = ? ORDER BY t.created_at, t.id`,
        )
        .all(projectId),
    ).map((row) => ({
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
      latestActivity: row.latest_activity,
      latestActivityAt: row.latest_activity_at,
      archivedAt: row.archived_at,
      deleteRequestedAt: row.delete_requested_at,
      deletedAt: row.deleted_at,
      purgeReceiptId: row.purge_receipt_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

  const taskDetail = (sessionId: string, taskId: string) => {
    const task = taskTree(sessionId).find((candidate) => candidate.id === taskId);
    if (!task) return null;
    const attempts: TraceAttemptView[] = decodeAttemptViewRows(
      sqlite
        .prepare(
          `SELECT id, invocation_id, attempt_number, chat_run_id, thread_id, status,
                  resumed_from_attempt_id, superseded_by_attempt_id, resumability,
                  started_at, finished_at, created_at, updated_at
           FROM agent_run_attempts WHERE task_id = ? ORDER BY attempt_number`,
        )
        .all(taskId),
    ).map((row) => ({
      id: row.id,
      invocationId: row.invocation_id,
      attemptNumber: row.attempt_number,
      chatRunId: row.chat_run_id,
      threadId: row.thread_id,
      status: row.status,
      resumedFromAttemptId: row.resumed_from_attempt_id,
      supersededByAttemptId: row.superseded_by_attempt_id,
      resumability: decodePayload(row.resumability),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const checkpoints: TraceCheckpointView[] = decodeCheckpointViewRows(
      sqlite
        .prepare(
          `SELECT id, attempt_id, event_sequence, transcript_message_id,
                  completed_tool_call_ids, uncertain_tool_call_ids, pending_approval_ids,
                  remaining_work, created_at
           FROM work_checkpoints WHERE task_id = ? ORDER BY created_at, id`,
        )
        .all(taskId),
    ).map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      eventSequence: row.event_sequence,
      transcriptMessageId: row.transcript_message_id,
      completedToolCallIds: decodeStringArray(row.completed_tool_call_ids),
      uncertainToolCallIds: decodeStringArray(row.uncertain_tool_call_ids),
      pendingApprovalIds: decodeStringArray(row.pending_approval_ids),
      remainingWork: row.remaining_work,
      createdAt: row.created_at,
    }));
    return {
      task,
      attempts,
      checkpoints,
      evidence: evidenceForTask(taskId),
      artifacts: artifactsForTask(taskId),
      adoptions: reportAdoptionsForTask(taskId),
      answerClaims: answerClaimsForTask(taskId),
      events: events(sessionId, 0, 500).filter((event) => event.taskId === taskId),
    };
  };

  const projectTaskDetail = (projectId: string, taskId: string) => {
    const task = projectTaskTree(projectId).find((candidate) => candidate.id === taskId);
    if (!task) return null;
    if (task.originSessionId !== null) return taskDetail(task.originSessionId, taskId);
    const attempts: TraceAttemptView[] = decodeAttemptViewRows(
      sqlite
        .prepare(
          `SELECT id, invocation_id, attempt_number, chat_run_id, thread_id, status,
                  resumed_from_attempt_id, superseded_by_attempt_id, resumability,
                  started_at, finished_at, created_at, updated_at
           FROM agent_run_attempts WHERE task_id = ? ORDER BY attempt_number`,
        )
        .all(taskId),
    ).map((row) => ({
      id: row.id,
      invocationId: row.invocation_id,
      attemptNumber: row.attempt_number,
      chatRunId: row.chat_run_id,
      threadId: row.thread_id,
      status: row.status,
      resumedFromAttemptId: row.resumed_from_attempt_id,
      supersededByAttemptId: row.superseded_by_attempt_id,
      resumability: decodePayload(row.resumability),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const checkpoints: TraceCheckpointView[] = decodeCheckpointViewRows(
      sqlite
        .prepare(
          `SELECT id, attempt_id, event_sequence, transcript_message_id,
                  completed_tool_call_ids, uncertain_tool_call_ids, pending_approval_ids,
                  remaining_work, created_at
           FROM work_checkpoints WHERE task_id = ? ORDER BY created_at, id`,
        )
        .all(taskId),
    ).map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      eventSequence: row.event_sequence,
      transcriptMessageId: row.transcript_message_id,
      completedToolCallIds: decodeStringArray(row.completed_tool_call_ids),
      uncertainToolCallIds: decodeStringArray(row.uncertain_tool_call_ids),
      pendingApprovalIds: decodeStringArray(row.pending_approval_ids),
      remainingWork: row.remaining_work,
      createdAt: row.created_at,
    }));
    const visibleEvents = decodeStoredEventRows(
      sqlite
        .prepare(
          `SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
                  attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
           FROM run_events WHERE task_id = ?
             AND visibility <> 'internal' AND redaction <> 'omitted'
           ORDER BY seq LIMIT 500`,
        )
        .all(taskId),
    ).map(eventView);
    return {
      task,
      attempts,
      checkpoints,
      evidence: evidenceForTask(taskId),
      artifacts: artifactsForTask(taskId),
      adoptions: reportAdoptionsForTask(taskId),
      answerClaims: answerClaimsForTask(taskId),
      events: visibleEvents,
    };
  };

  const claimResume = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly expectedAttemptId: string;
    readonly parentRunId: string;
    readonly parentToolCallId: string;
    readonly confirmUncertain: boolean;
  }): ResumeClaim =>
    atomic(() => {
      const candidate = sqlite
        .prepare(
          `SELECT t.id, t.origin_session_id, t.agent_id, t.request, t.status, t.active_attempt_id, t.archived_at, t.delete_requested_at, t.deleted_at,
                  a.id AS previous_attempt_id, a.attempt_number AS previous_attempt_number,
                  a.status AS previous_status, a.thread_id
           FROM work_tasks t
           JOIN agent_run_attempts a ON a.task_id = t.id
           WHERE t.id = ? AND t.origin_session_id = ?
           ORDER BY a.attempt_number DESC LIMIT 1`,
        )
        .get(input.taskId, input.sessionId);
      if (!candidate) return { status: "blocked", reason: "task_not_found" };
      const task = decodeResumeTask(candidate);
      if (task.deleted_at !== null || task.delete_requested_at !== null)
        return { status: "blocked", reason: "task_deleted" };
      if (task.archived_at !== null) return { status: "blocked", reason: "task_archived" };
      if (task.origin_session_id === null) return { status: "blocked", reason: "origin_deleted" };
      if (task.agent_id === null) return { status: "blocked", reason: "agent_deleted" };
      if (task.active_attempt_id) return { status: "blocked", reason: "attempt_alive" };
      if (task.status === "completed") return { status: "blocked", reason: "task_terminal" };
      if (task.previous_attempt_id !== input.expectedAttemptId)
        return { status: "blocked", reason: "stale_attempt" };
      const checkpointRow = sqlite
        .prepare(
          `SELECT id, completed_tool_call_ids, uncertain_tool_call_ids, pending_approval_ids,
                  remaining_work
           FROM work_checkpoints WHERE attempt_id = ? ORDER BY event_sequence DESC LIMIT 1`,
        )
        .get(task.previous_attempt_id);
      if (!checkpointRow) return { status: "blocked", reason: "missing_checkpoint" };
      const checkpoint = decodeCheckpoint(checkpointRow);
      const uncertainToolCallIds = decodeStringArray(checkpoint.uncertain_tool_call_ids);
      if (uncertainToolCallIds.length > 0 && !input.confirmUncertain)
        return { status: "blocked", reason: "uncertain_side_effect" };

      const now = Date.now();
      const invocationId = randomUUID();
      const attemptId = randomUUID();
      const chatRunId = randomUUID();
      const attemptNumber = task.previous_attempt_number + 1;
      sqlite
        .prepare(
          `INSERT INTO agent_invocations
           (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
            target_attempt_id, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, 'resume', 'accepted', ?, ?, ?, ?)`,
        )
        .run(
          invocationId,
          task.id,
          input.parentRunId,
          input.parentToolCallId,
          task.request,
          task.previous_attempt_id,
          `${input.parentRunId}:${input.parentToolCallId}`,
          now,
        );
      sqlite
        .prepare(
          `INSERT INTO agent_run_attempts
           (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
            resumed_from_attempt_id, resume_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          task.id,
          invocationId,
          attemptNumber,
          chatRunId,
          task.thread_id,
          task.previous_attempt_id,
          task.previous_status === "interrupted" ? "server_restarted" : "provider_failed",
          now,
          now,
        );
      sqlite
        .prepare(
          `UPDATE agent_run_attempts SET superseded_by_attempt_id = ?,
             resumability = '{"state":"not_needed"}', updated_at = ? WHERE id = ?`,
        )
        .run(attemptId, now, task.previous_attempt_id);
      sqlite
        .prepare(
          `UPDATE work_tasks SET status = 'resuming', active_attempt_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(attemptId, now, task.id);
      const handle = {
        id: attemptId,
        taskId: task.id,
        invocationId,
        chatRunId,
        threadId: task.thread_id,
        attemptNumber,
      };
      appendEvent({
        handle,
        sessionId: input.sessionId,
        kind: "resume_requested",
        summary: "Resume requested from the latest checkpoint",
        occurredAt: now,
      });
      return {
        status: "started",
        handle,
        agentId: task.agent_id,
        context: {
          originalRequest: task.request,
          remainingWork: checkpoint.remaining_work,
          completedToolCallIds: decodeStringArray(checkpoint.completed_tool_call_ids),
          uncertainToolCallIds,
          expiredApprovalIds: decodeStringArray(checkpoint.pending_approval_ids),
          checkpointId: checkpoint.id,
        },
      };
    });

  const eventView = (row: typeof StoredEventRow.Type): TraceEventView => ({
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
    payload: row.redaction === "redacted" ? {} : decodePayload(row.payload),
    occurredAt: row.occurred_at,
  });

  const requestSessionLifecycle = (input: {
    readonly sessionId: string;
    readonly intent: "archive" | "restore" | "delete";
    readonly idempotencyKey: string;
  }) =>
    atomic(() => {
      const retried = sqlite
        .prepare("SELECT * FROM lifecycle_operations WHERE idempotency_key = ?")
        .get(input.idempotencyKey);
      if (retried) return lifecycleOperationView(decodeLifecycleOperation(retried));
      // SAFETY: this statement selects exactly the typed session columns; absence is allowed.
      const session = sqlite
        .prepare("SELECT project_id, archived_at FROM sessions WHERE id = ?")
        .get(input.sessionId) as { project_id: string; archived_at: string | null } | undefined;
      if (!session) return { status: "blocked" as const, blocker: "session_not_found" };
      if (input.intent === "restore" && session.archived_at === null)
        return { status: "blocked" as const, blocker: "session_not_archived" };
      if (input.intent === "archive" && session.archived_at !== null)
        return { status: "completed" as const, targetId: input.sessionId, intent: input.intent };
      const now = Date.now();
      const operationId = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO lifecycle_operations
           (id, project_id, origin_session_id, target_kind, target_id, intent, status,
            idempotency_key, requested_at, updated_at)
           VALUES (?, ?, ?, 'session', ?, ?, 'cancelling', ?, ?, ?)`,
        )
        .run(
          operationId,
          session.project_id,
          input.sessionId,
          input.sessionId,
          input.intent,
          input.idempotencyKey,
          now,
          now,
        );
      return {
        operationId,
        projectId: session.project_id,
        sessionId: input.sessionId,
        targetKind: "session" as const,
        targetId: input.sessionId,
        intent: input.intent,
        status: "cancelling" as const,
        blocker: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: null,
      };
    });

  const finalizeSessionLifecycle = (operationId: string) =>
    atomic(() => {
      const found = sqlite
        .prepare("SELECT * FROM lifecycle_operations WHERE id = ?")
        .get(operationId);
      if (!found) return { status: "blocked" as const, blocker: "operation_not_found" };
      const operation = decodeLifecycleOperation(found);
      if (operation.status === "completed")
        return { status: "completed" as const, operationId, targetId: operation.target_id };
      const now = Date.now();
      const active = decodeId(
        sqlite
          .prepare(
            `SELECT coalesce(max(active_attempt_id), '') AS id FROM work_tasks
             WHERE origin_session_id = ? AND active_attempt_id IS NOT NULL`,
          )
          .get(operation.target_id),
      ).id;
      if (active !== "") {
        sqlite
          .prepare(
            "UPDATE lifecycle_operations SET status = 'waiting_for_stop', updated_at = ? WHERE id = ?",
          )
          .run(now, operationId);
        return { status: "waiting_for_stop" as const, operationId, targetId: operation.target_id };
      }
      if (operation.intent === "restore")
        sqlite
          .prepare("UPDATE sessions SET archived_at = NULL WHERE id = ?")
          .run(operation.target_id);
      else if (operation.intent === "archive")
        sqlite
          .prepare("UPDATE sessions SET archived_at = ? WHERE id = ?")
          .run(new Date(now).toISOString(), operation.target_id);
      else {
        const remaining = decodeId(
          sqlite
            .prepare(
              `SELECT coalesce(max(id), '') AS id FROM work_tasks
               WHERE origin_session_id = ? AND deleted_at IS NULL`,
            )
            .get(operation.target_id),
        ).id;
        if (remaining !== "") {
          sqlite
            .prepare(
              `UPDATE lifecycle_operations SET status = 'blocked', blocker = 'task_purge_required',
                      updated_at = ? WHERE id = ?`,
            )
            .run(now, operationId);
          return { status: "blocked" as const, blocker: "task_purge_required", operationId };
        }
        sqlite
          .prepare(
            "UPDATE lifecycle_operations SET status = 'purging', updated_at = ? WHERE id = ?",
          )
          .run(now, operationId);
        // SAFETY: this statement selects exactly the typed node columns.
        const nodeRows = sqlite
          .prepare("SELECT seq, id, text FROM nodes WHERE session_id = ? ORDER BY seq")
          .all(operation.target_id) as { seq: number; id: string; text: string }[];
        // SAFETY: this statement selects the string primary key only.
        const subagentRows = sqlite
          .prepare("SELECT id FROM subagents WHERE session_id = ?")
          .all(operation.target_id) as { id: string }[];
        for (const node of nodeRows) {
          sqlite
            .prepare("INSERT INTO nodes_fts(nodes_fts, rowid, text) VALUES ('delete', ?, ?)")
            .run(node.seq, node.text);
          sqlite
            .prepare("DELETE FROM interpretations WHERE node_id = ? OR target_id = ?")
            .run(node.id, node.id);
          sqlite.prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?").run(node.id, node.id);
          sqlite.prepare("DELETE FROM node_refs WHERE node_id = ?").run(node.id);
          sqlite.prepare("DELETE FROM node_attachments WHERE node_id = ?").run(node.id);
          sqlite.prepare("DELETE FROM imported_nodes WHERE node_id = ?").run(node.id);
          sqlite.prepare("DELETE FROM interpret_jobs WHERE node_id = ?").run(node.id);
          sqlite.prepare("DELETE FROM node_vectors WHERE node_seq = ?").run(node.seq);
          sqlite.prepare("DELETE FROM node_morphs WHERE node_seq = ?").run(node.seq);
        }
        sqlite.prepare("DELETE FROM nodes WHERE session_id = ?").run(operation.target_id);
        const threadIds = [operation.target_id, ...subagentRows.map((row) => `subagent-${row.id}`)];
        for (const threadId of threadIds) {
          // SAFETY: this statement selects the string run identifier only.
          const runIds = sqlite
            .prepare("SELECT run_id FROM chat_runs WHERE thread_id = ?")
            .all(threadId) as {
            run_id: string;
          }[];
          for (const run of runIds)
            sqlite.prepare("DELETE FROM chat_interrupts WHERE run_id = ?").run(run.run_id);
          sqlite.prepare("DELETE FROM chat_interrupts WHERE thread_id = ?").run(threadId);
          sqlite.prepare("DELETE FROM chat_runs WHERE thread_id = ?").run(threadId);
          sqlite.prepare("DELETE FROM chat_threads WHERE thread_id = ?").run(threadId);
        }
        sqlite
          .prepare("DELETE FROM permission_reviews WHERE session_id = ?")
          .run(operation.target_id);
        sqlite.prepare("DELETE FROM queued_messages WHERE session_id = ?").run(operation.target_id);
        sqlite
          .prepare("DELETE FROM imported_sessions WHERE session_id = ?")
          .run(operation.target_id);
        sqlite
          .prepare("DELETE FROM session_workflows WHERE session_id = ?")
          .run(operation.target_id);
        sqlite.prepare("DELETE FROM subagents WHERE session_id = ?").run(operation.target_id);
        sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(operation.target_id);
        const receiptId = randomUUID();
        sqlite
          .prepare(
            `INSERT INTO purge_receipts
             (id, operation_id, project_id, target_kind, target_id, policy_version,
              purged_counts, retained_kinds, completed_at)
             VALUES (?, ?, ?, 'session', ?, 1, ?, ?, ?)`,
          )
          .run(
            receiptId,
            operationId,
            operation.project_id,
            operation.target_id,
            JSON.stringify({ nodes: nodeRows.length, subagents: subagentRows.length }),
            JSON.stringify([
              "task_tombstones",
              "answer_claims",
              "adopted_memory",
              "purge_receipts",
            ]),
            now,
          );
      }
      sqlite
        .prepare(
          `UPDATE lifecycle_operations SET status = 'completed', blocker = NULL,
                  updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(now, now, operationId);
      return {
        status: "completed" as const,
        operationId,
        targetId: operation.target_id,
        intent: operation.intent,
      };
    });

  const lifecycleOperationView = (row: typeof LifecycleOperationRow.Type) => ({
    operationId: row.id,
    projectId: row.project_id,
    sessionId: row.origin_session_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    intent: row.intent,
    status: row.status,
    blocker: row.blocker,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });

  /**
   * Persist a task archive/delete request before touching the live child. The unique active-target
   * index serializes archive/delete/resume races; retries with the same key return the same row.
   */
  const requestTaskLifecycle = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly intent: "archive" | "restore" | "delete";
    readonly idempotencyKey: string;
  }) =>
    atomic(() => {
      const retried = sqlite
        .prepare("SELECT * FROM lifecycle_operations WHERE idempotency_key = ?")
        .get(input.idempotencyKey);
      if (retried) return { ...lifecycleOperationView(decodeLifecycleOperation(retried)) };
      const found = sqlite
        .prepare(
          `SELECT project_id, origin_session_id, agent_id, parent_run_id, active_attempt_id,
                  archived_at, delete_requested_at, deleted_at, purge_receipt_id
           FROM work_tasks WHERE id = ? AND origin_session_id = ?`,
        )
        .get(input.taskId, input.sessionId);
      if (!found) return { status: "blocked" as const, blocker: "task_not_found" };
      const task = decodeLifecycleTask(found);
      if (task.deleted_at !== null)
        return {
          status: "completed" as const,
          targetId: input.taskId,
          intent: "delete" as const,
          receiptId: task.purge_receipt_id,
        };
      if (input.intent === "restore" && task.archived_at === null)
        return { status: "blocked" as const, blocker: "task_not_archived" };
      if (input.intent === "archive" && task.archived_at !== null)
        return { status: "completed" as const, targetId: input.taskId, intent: input.intent };
      const now = Date.now();
      const id = randomUUID();
      const status = task.active_attempt_id === null ? "requested" : "cancelling";
      sqlite
        .prepare(
          `INSERT INTO lifecycle_operations
           (id, project_id, origin_session_id, target_kind, target_id, intent, status,
            idempotency_key, requested_at, updated_at)
           VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          task.project_id,
          task.origin_session_id,
          input.taskId,
          input.intent,
          status,
          input.idempotencyKey,
          now,
          now,
        );
      if (input.intent === "delete")
        sqlite
          .prepare("UPDATE work_tasks SET delete_requested_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, input.taskId);
      return {
        operationId: id,
        projectId: task.project_id,
        sessionId: task.origin_session_id,
        targetKind: "task" as const,
        targetId: input.taskId,
        intent: input.intent,
        status,
        blocker: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: null,
        agentId: task.agent_id,
        activeAttemptId: task.active_attempt_id,
      };
    });

  const finalizeTaskLifecycle = (operationId: string) => {
    const completed = atomic(() => {
      const found = sqlite
        .prepare("SELECT * FROM lifecycle_operations WHERE id = ?")
        .get(operationId);
      if (!found) return { status: "blocked" as const, blocker: "operation_not_found" };
      const operation = decodeLifecycleOperation(found);
      if (operation.status === "completed")
        return { status: "completed" as const, operationId, targetId: operation.target_id };
      const task = decodeLifecycleTask(
        sqlite
          .prepare(
            `SELECT project_id, origin_session_id, agent_id, parent_run_id, active_attempt_id,
                    archived_at, delete_requested_at, deleted_at, purge_receipt_id
             FROM work_tasks WHERE id = ?`,
          )
          .get(operation.target_id),
      );
      const now = Date.now();
      if (task.active_attempt_id !== null) {
        sqlite
          .prepare(
            "UPDATE lifecycle_operations SET status = 'waiting_for_stop', updated_at = ? WHERE id = ?",
          )
          .run(now, operationId);
        return { status: "waiting_for_stop" as const, operationId, targetId: operation.target_id };
      }
      if (operation.intent === "restore") {
        sqlite
          .prepare("UPDATE work_tasks SET archived_at = NULL, updated_at = ? WHERE id = ?")
          .run(now, operation.target_id);
      } else if (operation.intent === "archive") {
        sqlite
          .prepare("UPDATE work_tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, operation.target_id);
      } else {
        sqlite
          .prepare(
            "UPDATE lifecycle_operations SET status = 'purging', updated_at = ? WHERE id = ?",
          )
          .run(now, operationId);
        const evidence = sqlite
          .prepare(
            `UPDATE evidence_refs SET locator = NULL, verification = 'source_deleted',
                    source_deleted_at = ?, updated_at = ? WHERE task_id = ?`,
          )
          .run(now, now, operation.target_id).changes;
        sqlite
          .prepare(
            `UPDATE memory_candidate_evidence SET evidence_ref_id = NULL, source_deleted_at = ?
             WHERE evidence_ref_id IN (SELECT id FROM evidence_refs WHERE task_id = ?)`,
          )
          .run(now, operation.target_id);
        const artifacts = sqlite
          .prepare(
            `UPDATE work_artifacts SET locator = NULL, verification = 'source_deleted',
                    source_deleted_at = ?, updated_at = ? WHERE task_id = ?`,
          )
          .run(now, now, operation.target_id).changes;
        const checkpoints = sqlite
          .prepare("DELETE FROM work_checkpoints WHERE task_id = ?")
          .run(operation.target_id).changes;
        const events = sqlite
          .prepare("DELETE FROM run_events WHERE task_id = ?")
          .run(operation.target_id).changes;
        sqlite
          .prepare("UPDATE agent_invocations SET message = '' WHERE task_id = ?")
          .run(operation.target_id);
        sqlite
          .prepare(
            `UPDATE parent_notifications SET summary = 'Deleted task lifecycle notification', payload = '{}'
             WHERE task_id = ?`,
          )
          .run(operation.target_id);
        const receiptId = randomUUID();
        sqlite
          .prepare(
            `INSERT INTO purge_receipts
             (id, operation_id, project_id, target_kind, target_id, policy_version,
              purged_counts, retained_kinds, completed_at)
             VALUES (?, ?, ?, 'task', ?, 1, ?, ?, ?)`,
          )
          .run(
            receiptId,
            operationId,
            operation.project_id,
            operation.target_id,
            JSON.stringify({ evidence, artifacts, checkpoints, events }),
            JSON.stringify([
              "task_tombstone",
              "attempt_lineage",
              "answer_claims",
              "adopted_memory",
            ]),
            now,
          );
        sqlite
          .prepare(
            `UPDATE work_tasks SET title = 'Deleted task', request = '', agent_name = 'deleted subagent',
                    archived_at = NULL, deleted_at = ?, purge_receipt_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, receiptId, now, operation.target_id);
      }
      sqlite
        .prepare(
          `UPDATE lifecycle_operations SET status = 'completed', blocker = NULL,
                  updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(now, now, operationId);
      return {
        status: "completed" as const,
        operationId,
        targetId: operation.target_id,
        intent: operation.intent,
        receiptId:
          operation.intent === "delete"
            ? decodeLifecycleTask(
                sqlite
                  .prepare(
                    `SELECT project_id, origin_session_id, agent_id, parent_run_id, active_attempt_id,
                            archived_at, delete_requested_at, deleted_at, purge_receipt_id
                     FROM work_tasks WHERE id = ?`,
                  )
                  .get(operation.target_id),
              ).purge_receipt_id
            : null,
      };
    });
    if (completed.status === "completed") {
      const operation = decodeLifecycleOperation(
        sqlite.prepare("SELECT * FROM lifecycle_operations WHERE id = ?").get(operationId),
      );
      if (operation.intent !== "restore")
        notifyParent({
          taskId: operation.target_id,
          kind: operation.intent === "delete" ? "deleted" : "archived",
          summary:
            operation.intent === "delete"
              ? "Subagent task deleted; adopted project knowledge was retained"
              : "Subagent task archived",
          idempotencyKey: `lifecycle:${operationId}:${operation.intent}`,
          payload: {
            operationId,
            receiptId: "receiptId" in completed ? (completed.receiptId ?? null) : null,
          },
        });
    }
    return completed;
  };

  /** Archives a non-active task without discarding its execution status or project provenance. */
  const recoverLifecycleOperations = () => {
    // SAFETY: the lifecycle schema constrains target_kind and intent to these literal unions.
    const pending = sqlite
      .prepare(
        `SELECT id, target_kind, target_id, intent FROM lifecycle_operations
         WHERE status IN ('requested', 'cancelling', 'waiting_for_stop', 'purging', 'blocked')
         ORDER BY CASE target_kind WHEN 'task' THEN 0 ELSE 1 END, requested_at, id`,
      )
      .all() as {
      id: string;
      target_kind: "task" | "session";
      target_id: string;
      intent: "archive" | "restore" | "delete";
    }[];
    for (const operation of pending) {
      if (operation.target_kind === "task") {
        finalizeTaskLifecycle(operation.id);
        continue;
      }
      if (operation.intent === "delete") {
        // SAFETY: this statement selects the string Task primary key only.
        const tasks = sqlite
          .prepare(
            `SELECT id FROM work_tasks
             WHERE origin_session_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
          )
          .all(operation.target_id) as { id: string }[];
        for (const task of tasks) {
          const requested = requestTaskLifecycle({
            sessionId: operation.target_id,
            taskId: task.id,
            intent: "delete",
            idempotencyKey: `session:${operation.id}:task:${task.id}`,
          });
          if (
            requested.status !== "completed" &&
            "operationId" in requested &&
            requested.operationId
          )
            finalizeTaskLifecycle(requested.operationId);
        }
      }
      finalizeSessionLifecycle(operation.id);
    }
  };

  const archiveTask = (sessionId: string, taskId: string) =>
    atomic(() => {
      const existing = sqlite
        .prepare(
          `SELECT active_attempt_id, status, archived_at FROM work_tasks
           WHERE id = ? AND origin_session_id = ?`,
        )
        .get(taskId, sessionId);
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({
          active_attempt_id: Schema.NullOr(Schema.String),
          status: Schema.String,
          archived_at: Schema.NullOr(Schema.Number),
        }),
      )(existing);
      if (Option.isNone(decoded))
        return { status: "blocked" as const, reason: "task_not_found" as const };
      const task = decoded.value;
      if (task.archived_at !== null) return { status: "archived" as const, taskId };
      if (task.active_attempt_id !== null)
        return { status: "blocked" as const, reason: "attempt_alive" as const };
      if (
        !new Set(["interrupted", "resumable", "completed", "failed", "cancelled"]).has(task.status)
      )
        return { status: "blocked" as const, reason: "task_not_archivable" as const };
      sqlite
        .prepare("UPDATE work_tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), taskId);
      return { status: "archived" as const, taskId };
    });

  /**
   * Queue a user-requested logical resume. Execution waits for the next valid parent run so the
   * child receives the current model, project tools, permission policy and abort ownership.
   */
  const requestResume = (input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly expectedAttemptId: string;
    readonly confirmUncertain: boolean;
  }) =>
    atomic(() => {
      const candidate = sqlite
        .prepare(
          `SELECT t.id, t.origin_session_id, t.agent_id, t.request, t.status, t.active_attempt_id, t.archived_at, t.delete_requested_at, t.deleted_at,
                  a.id AS previous_attempt_id, a.attempt_number AS previous_attempt_number,
                  a.status AS previous_status, a.thread_id
           FROM work_tasks t
           JOIN agent_run_attempts a ON a.task_id = t.id
           WHERE t.id = ? AND t.origin_session_id = ?
           ORDER BY a.attempt_number DESC LIMIT 1`,
        )
        .get(input.taskId, input.sessionId);
      if (!candidate) return { status: "blocked" as const, reason: "task_not_found" as const };
      const task = decodeResumeTask(candidate);
      if (task.deleted_at !== null || task.delete_requested_at !== null)
        return { status: "blocked" as const, reason: "task_deleted" as const };
      if (task.archived_at !== null)
        return { status: "blocked" as const, reason: "task_archived" as const };
      if (task.origin_session_id === null)
        return { status: "blocked" as const, reason: "origin_deleted" as const };
      if (task.agent_id === null)
        return { status: "blocked" as const, reason: "agent_deleted" as const };
      if (task.active_attempt_id)
        return { status: "blocked" as const, reason: "attempt_alive" as const };
      if (task.status === "completed")
        return { status: "blocked" as const, reason: "task_terminal" as const };
      if (task.previous_attempt_id !== input.expectedAttemptId)
        return { status: "blocked" as const, reason: "stale_attempt" as const };
      const checkpointRow = sqlite
        .prepare(
          `SELECT id, completed_tool_call_ids, uncertain_tool_call_ids, pending_approval_ids,
                  remaining_work
           FROM work_checkpoints WHERE attempt_id = ? ORDER BY event_sequence DESC LIMIT 1`,
        )
        .get(task.previous_attempt_id);
      if (!checkpointRow)
        return { status: "blocked" as const, reason: "missing_checkpoint" as const };
      const checkpoint = decodeCheckpoint(checkpointRow);
      const uncertain = decodeStringArray(checkpoint.uncertain_tool_call_ids);
      if (uncertain.length > 0 && !input.confirmUncertain)
        return { status: "blocked" as const, reason: "uncertain_side_effect" as const };

      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO work_recovery_jobs
           (id, project_id, task_id, interrupted_attempt_id, status, blocker,
            claimed_by, claimed_at, created_at, updated_at, confirm_uncertain)
           SELECT ?, project_id, id, ?, 'queued', NULL, NULL, NULL, ?, ?, ?
           FROM work_tasks WHERE id = ?
           ON CONFLICT(task_id) DO UPDATE SET
             interrupted_attempt_id = excluded.interrupted_attempt_id,
             status = 'queued', blocker = NULL, claimed_by = NULL, claimed_at = NULL,
             updated_at = excluded.updated_at,
             confirm_uncertain = excluded.confirm_uncertain`,
        )
        .run(
          randomUUID(),
          task.previous_attempt_id,
          now,
          now,
          input.confirmUncertain ? 1 : 0,
          task.id,
        );
      const queued = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        sqlite.prepare("SELECT id FROM work_recovery_jobs WHERE task_id = ?").get(task.id),
      );
      return {
        status: "queued" as const,
        jobId: queued.id,
        taskId: task.id,
        expectedAttemptId: task.previous_attempt_id,
      };
    });

  const claimRecoveryJobs = (sessionId: string, parentRunId: string) =>
    atomic(() => {
      const jobs = decodeRecoveryJobRows(
        sqlite
          .prepare(
            `SELECT j.id, j.task_id, j.interrupted_attempt_id, j.confirm_uncertain
             FROM work_recovery_jobs j JOIN work_tasks t ON t.id = j.task_id
             WHERE j.status = 'queued' AND t.origin_session_id = ?
             ORDER BY j.created_at, j.id`,
          )
          .all(sessionId),
      );
      const claimed: Array<{
        readonly jobId: string;
        readonly claim: Extract<ResumeClaim, { readonly status: "started" }>;
      }> = [];
      for (const job of jobs) {
        const now = Date.now();
        const acquired = sqlite
          .prepare(
            `UPDATE work_recovery_jobs
             SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(parentRunId, now, now, job.id);
        if (acquired.changes !== 1) continue;
        const claim = claimResume({
          sessionId,
          taskId: job.task_id,
          expectedAttemptId: job.interrupted_attempt_id,
          parentRunId,
          parentToolCallId: `recovery:${job.id}`,
          confirmUncertain: job.confirm_uncertain === 1,
        });
        if (claim.status === "started") claimed.push({ jobId: job.id, claim });
        else
          sqlite
            .prepare(
              `UPDATE work_recovery_jobs SET status = 'blocked', blocker = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              claim.reason === "origin_deleted" || claim.reason === "agent_deleted"
                ? claim.reason
                : "missing_checkpoint",
              now,
              job.id,
            );
      }
      return claimed;
    });

  const finishRecoveryJob = (jobId: string, completed: boolean) =>
    sqlite
      .prepare(
        `UPDATE work_recovery_jobs SET status = ?, updated_at = ?
         WHERE id = ? AND status = 'claimed'`,
      )
      .run(completed ? "completed" : "failed", Date.now(), jobId).changes === 1;

  const events = (sessionId: string, afterCursor = 0, limit = 200): TraceEventView[] =>
    decodeStoredEventRows(
      sqlite
        .prepare(
          `SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
                  attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
           FROM run_events
           WHERE origin_session_id = ? AND seq > ?
             AND visibility <> 'internal' AND redaction <> 'omitted'
           ORDER BY seq LIMIT ?`,
        )
        .all(sessionId, Math.max(0, afterCursor), Math.min(Math.max(1, limit), 500)),
    ).map(eventView);

  const latestCursor = (sessionId: string) => {
    const row = decodeCursor(
      sqlite
        .prepare("SELECT coalesce(max(seq), 0) AS seq FROM run_events WHERE origin_session_id = ?")
        .get(sessionId),
    );
    return row.seq;
  };

  const projectLatestCursor = (projectId: string) => {
    const row = decodeCursor(
      sqlite
        .prepare(
          `SELECT coalesce(max(e.seq), 0) AS seq
           FROM run_events e JOIN work_tasks t ON t.id = e.task_id WHERE t.project_id = ?`,
        )
        .get(projectId),
    );
    return row.seq;
  };

  const snapshot = (sessionId: string, afterCursor = 0, limit = 500) =>
    atomic(() => {
      const upperCursor = latestCursor(sessionId);
      const boundedLimit = Math.min(Math.max(1, limit), 500);
      const rows = decodeStoredEventRows(
        sqlite
          .prepare(
            `SELECT seq AS cursor, id, origin_session_id, task_id, invocation_id, attempt_id,
                    attempt_sequence, kind, visibility, redaction, summary, payload, occurred_at
             FROM run_events
             WHERE origin_session_id = ? AND seq > ? AND seq <= ?
               AND visibility <> 'internal' AND redaction <> 'omitted'
             ORDER BY seq LIMIT ?`,
          )
          .all(sessionId, Math.max(0, afterCursor), upperCursor, boundedLimit),
      );
      const cursor =
        rows.length === boundedLimit ? (rows.at(-1)?.cursor ?? afterCursor) : upperCursor;
      return { cursor, events: rows.map(eventView) };
    });

  const waitForChange = (
    sessionId: string,
    afterCursor: number,
    signal: AbortSignal,
    heartbeatMs = 15_000,
  ): Promise<"event" | "heartbeat" | "aborted"> => {
    if (signal.aborted) return Promise.resolve("aborted");
    if (latestCursor(sessionId) > afterCursor) return Promise.resolve("event");
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: "event" | "heartbeat" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(listener);
        signal.removeEventListener("abort", aborted);
        resolve(result);
      };
      const listener = (changedSessionId: string, cursor: number) => {
        if (changedSessionId === sessionId && cursor > afterCursor) done("event");
      };
      const aborted = () => done("aborted");
      const timer = setTimeout(() => done("heartbeat"), Math.max(1, heartbeatMs));
      listeners.add(listener);
      signal.addEventListener("abort", aborted, { once: true });
      if (latestCursor(sessionId) > afterCursor) done("event");
    });
  };

  const attemptHandle = (taskId: string, attemptId: string): AttemptHandle | null => {
    const row = sqlite
      .prepare("SELECT * FROM agent_run_attempts WHERE id = ? AND task_id = ?")
      .get(attemptId, taskId);
    if (!row) return null;
    const attempt = decodeAttempt(row);
    return {
      id: attempt.id,
      taskId: attempt.task_id,
      invocationId: attempt.invocation_id,
      chatRunId: attempt.chat_run_id,
      threadId: attempt.thread_id,
      attemptNumber: attempt.attempt_number,
    };
  };

  const activeAttemptForAgent = (agentId: string): AttemptHandle | null => {
    const row = sqlite
      .prepare(
        `SELECT a.* FROM agent_run_attempts a
         JOIN work_tasks t ON t.id = a.task_id
         WHERE t.agent_id = ? AND a.status IN ('queued', 'running', 'waiting', 'blocked')
         ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(agentId);
    if (!row) return null;
    const decoded = decodeAttempt(row);
    return {
      id: decoded.id,
      taskId: decoded.task_id,
      invocationId: decoded.invocation_id,
      attemptNumber: decoded.attempt_number,
      chatRunId: decoded.chat_run_id,
      threadId: decoded.thread_id,
    };
  };

  return {
    recoveredAttempts: recover,
    startAttempt,
    recordSteer,
    appendEvent,
    notifyParent,
    consumeParentNotifications,
    releaseParentNotifications,
    transitionAttempt,
    checkpoint,
    recordEvidence,
    setEvidenceVerification,
    markEvidenceSourceDeleted,
    recordArtifact,
    setArtifactVerification,
    markArtifactSourceDeleted,
    evidenceForTask,
    artifactsForTask,
    evidenceIdsForAttempt,
    recordReportDisposition,
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
    recoverLifecycleOperations,
    archiveTask,
    claimRecoveryJobs,
    finishRecoveryJob,
    events,
    snapshot,
    latestCursor,
    projectLatestCursor,
    waitForChange,
    attemptHandle,
    activeAttemptForAgent,
  };
});

export class WorkTraceStore extends Context.Tag("memory-agent/WorkTraceStore")<
  WorkTraceStore,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(WorkTraceStore, make);
}
