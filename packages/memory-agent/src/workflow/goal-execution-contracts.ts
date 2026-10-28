import { Function as EffectFunction, Result, Schema } from "effect";
import { sha256 } from "../runtime/synchronous-crypto.ts";

const Identifier = Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()));
const RevisionId = Schema.Natural;
const ExecutionId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/)));

/** Identifies the owner process generation allowed to admit and resume this execution. */
export const GoalExecutionOwnerIdentity = Schema.Struct({
  ownerId: Identifier,
  generation: Identifier,
});
export type GoalExecutionOwnerIdentity = typeof GoalExecutionOwnerIdentity.Type;

/** Stable inputs that uniquely identify one owner-bound Goal execution. */
export const GoalExecutionIdentity = Schema.Struct({
  owner: GoalExecutionOwnerIdentity,
  sessionId: Identifier,
  runId: Identifier,
  goalInstanceId: Identifier,
  workflowRevisionId: RevisionId,
});
export type GoalExecutionIdentity = typeof GoalExecutionIdentity.Type;

export const GoalExecutionPayload = Schema.TaggedStruct("GoalExecutionPayload", {
  identity: GoalExecutionIdentity,
});
export type GoalExecutionPayload = typeof GoalExecutionPayload.Type;

export const GoalExecutionSuccess = Schema.TaggedStruct("GoalExecutionSuccess", {
  executionId: ExecutionId,
  runId: Identifier,
  outcome: Schema.Literal("completed"),
});
export type GoalExecutionSuccess = typeof GoalExecutionSuccess.Type;

export const GoalExecutionErrorReason = Schema.TaggedUnion({
  AdmissionRejected: {
    reason: Schema.Literals([
      "legacy_unbound",
      "workflow_changed",
      "run_id_conflict",
      "run_outcome_uncertain",
      "owner_mismatch",
    ]),
  },
  SideEffectUncertain: {
    operationId: Identifier,
    state: Schema.Literals(["pending", "uncertain"]),
  },
  ExecutionFailed: {
    phase: Schema.Literals(["owner_admission", "sdk_loop", "approval", "completion"]),
    code: Identifier,
  },
});
export type GoalExecutionErrorReason = typeof GoalExecutionErrorReason.Type;

export class GoalExecutionError extends Schema.TaggedError<
  GoalExecutionError,
  { readonly brand: unique symbol }
>()("GoalExecutionError", {
  executionId: ExecutionId,
  reason: GoalExecutionErrorReason,
}) {}

/** Only a succeeded receipt is replayable. Pending and uncertain operations stop execution. */
export const GoalExecutionSideEffectState = Schema.TaggedUnion({
  Succeeded: {
    operationId: Identifier,
    replay: Schema.Literal("reuse_receipt"),
    receipt: Schema.Json,
  },
  Pending: {
    operationId: Identifier,
    disposition: Schema.Literal("stop"),
  },
  Uncertain: {
    operationId: Identifier,
    disposition: Schema.Literal("stop"),
  },
});
export type GoalExecutionSideEffectState = typeof GoalExecutionSideEffectState.Type;

const GoalExecutionIdentityTuple = Schema.Tuple([Identifier, Identifier, Identifier, RevisionId]);
const encodeIdentity = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(GoalExecutionIdentityTuple)),
  Result.getOrThrow,
);

/**
 * Stable idempotency key for a Goal execution. Owner identity and process generation are fencing
 * capabilities, not execution identity: a different owner must collide with the same durable
 * session/run/Goal/revision request instead of creating a second workflow. The schema encoder
 * supplies a canonical, separator-safe JSON representation; the ID contains no raw identity or
 * user content.
 */
export function goalExecutionIdempotencyKey(identity: GoalExecutionIdentity): string {
  const canonical = encodeIdentity([
    identity.sessionId,
    identity.runId,
    identity.goalInstanceId,
    identity.workflowRevisionId,
  ]);
  const digest = sha256(canonical);
  return `goal-execution-v1-${digest}`;
}
