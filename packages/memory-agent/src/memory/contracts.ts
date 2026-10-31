import { Schema } from "effect";

/** What became of a memory a task proposed. */
export const MemoryDisposition = Schema.Literals([
  "saved",
  "edited_saved",
  "conversation_only",
  "rejected",
]);
export type MemoryDisposition = typeof MemoryDisposition.Type;

/** A memory a task's answer proposed, as the user resolved it. */
export const MemoryCandidateView = Schema.Struct({
  id: Schema.String,
  decisionId: Schema.String,
  projectId: Schema.String,
  taskId: Schema.String,
  attemptId: Schema.String,
  claimId: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  authorizedByUserNodeId: Schema.String,
  proposedText: Schema.String,
  resolvedText: Schema.String,
  disposition: MemoryDisposition,
  memoryNodeId: Schema.NullOr(Schema.String),
  /** Evidence ids a promotion listed before evidence records were dropped; new ones list none. */
  evidence: Schema.Array(
    Schema.Struct({
      evidenceRefId: Schema.String,
      sourceDeletedAt: Schema.NullOr(Schema.Finite),
    }),
  ),
  createdAt: Schema.Finite,
});
export type MemoryCandidateView = typeof MemoryCandidateView.Type;

/** A saved memory a run retrieved, or used in its answer. */
export const MemoryUsageView = Schema.Struct({
  id: Schema.String,
  candidateId: Schema.String,
  memoryNodeId: Schema.String,
  originSessionId: Schema.NullOr(Schema.String),
  parentRunId: Schema.String,
  parentMessageId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["retrieved", "used"]),
  createdAt: Schema.Finite,
});
export type MemoryUsageView = typeof MemoryUsageView.Type;
