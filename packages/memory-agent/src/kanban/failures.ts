import { Schema } from "effect";
import type { CardWorktreeFailed } from "./worktree.ts";

/**
 * Why kanban cards fail and why the loop holds them, as closed literal sets (decisions.md "칸반 실패
 * 사유는 닫힌 태그로 (2026-10-18)"). Pages pick their wording from the tags; words a model wrote are
 * kept apart in `note` and never branched on. Anything not named here is a `Defect`.
 */

/** Why a verifier did not pass a card or a Goal branch. Only `Rejected` carries its own words. */
export const VerdictFailure = Schema.Union([
  /** The verifier checked and found the work short; `note` is what it wrote. */
  Schema.TaggedStruct("Rejected", { note: Schema.String }),
  /** The verifier finished without recording a verdict. */
  Schema.TaggedStruct("NoVerdict", {}),
  Schema.TaggedStruct("NotFinished", {}),
  Schema.TaggedStruct("ModelSelectionRequired", {}),
  /** The verifier could not run: its session, project or run failed. */
  Schema.TaggedStruct("Unavailable", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type VerdictFailure = typeof VerdictFailure.Type;

/** How a card's agent run ended without finishing the card. */
export const AgentFailureCode = Schema.Literals([
  "model_selection_required",
  "not_started",
  "failed",
  "cancelled",
  /** The run could not start or record itself: session, project or run storage failed. */
  "unavailable",
]);
export type AgentFailureCode = typeof AgentFailureCode.Type;

export const WorktreeFailureReason = Schema.Literals([
  "SequentialRequired",
  "InvalidId",
  "UnsafeWorktreeBase",
  "GoalBranchMissing",
  "WorktreeOccupied",
  "WorktreeMissing",
  "WorktreeDirty",
  "InUse",
  "GoalAdvanced",
  "TargetMissing",
  "GitFailed",
] as const satisfies readonly CardWorktreeFailed["reason"]["_tag"][]);

/** Why one attempt or verification of a card failed. */
export const CardFailure = Schema.Union([
  Schema.TaggedStruct("Agent", { code: AgentFailureCode }),
  Schema.TaggedStruct("Worktree", { reason: WorktreeFailureReason }),
  Schema.TaggedStruct("Verification", { verdict: VerdictFailure }),
  /** The Goal branch moved during every verification round. */
  Schema.TaggedStruct("GoalBranchKeptMoving", {}),
  Schema.TaggedStruct("Defect", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CardFailure = typeof CardFailure.Type;

export const worktreeFailure = (failure: CardWorktreeFailed): CardFailure => ({
  _tag: "Worktree",
  reason: failure.reason._tag,
});

/** Why the loop stopped or delayed a card, as the board shows it. */
export const CardHoldReason = Schema.Union([
  Schema.TaggedStruct("RetryBackoff", { failure: CardFailure }),
  /** The orchestrator model replaces the card; no failure when a person asked for it. */
  Schema.TaggedStruct("ReplanRequested", { failure: Schema.NullOr(CardFailure) }),
  Schema.TaggedStruct("RepeatedFailure", { failure: CardFailure }),
  Schema.TaggedStruct("MergeConflict", { files: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("UncertainEffect", { runId: Schema.String }),
  /** The card's queue item ran out of deliveries. */
  Schema.TaggedStruct("DeadLettered", {}),
  /** The orchestrator model stopped the card or asks a person about it after a Goal change. */
  Schema.TaggedStruct("GoalChanged", { note: Schema.String }),
  Schema.TaggedStruct("UpstreamRegressed", { verdict: VerdictFailure }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CardHoldReason = typeof CardHoldReason.Type;

/** The failure as revision details and logs name it: tags only, never a model's words. */
export const failureCode = CardFailure.match({
  Agent: (failure) => `agent_${failure.code}`,
  Worktree: (failure) => `worktree_${failure.reason}`,
  Verification: (failure) => `verification_${failure.verdict._tag}`,
  GoalBranchKeptMoving: () => "goal_branch_kept_moving",
  Defect: () => "defect",
});
