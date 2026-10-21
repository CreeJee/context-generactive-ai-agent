import { Schema } from "effect";
import {
  cardWorktreeFailedReasonName,
  type CardWorktreeFailed,
  type CardWorktreeFailedReason,
} from "./worktree.ts";

/**
 * Why kanban cards fail and why the loop holds them, as closed literal sets (decisions.md "칸반 실패
 * 사유는 닫힌 태그로 (2026-10-18)"). Pages pick their wording from the tags; words a model wrote are
 * kept apart in `note` and never branched on. Anything not named here is a `Defect`.
 */

/** Why a verifier did not pass a card or a Goal branch. Only `Rejected` carries its own words. */
export const VerdictFailure = Schema.TaggedUnion({
  /** The verifier checked and found the work short; `note` is what it wrote. */
  Rejected: { note: Schema.String },
  /** The verifier finished without recording a verdict. */
  NoVerdict: {},
  NotFinished: {},
  ModelSelectionRequired: {},
  /** The verifier could not run: its session, project or run failed. */
  Unavailable: {},
});
export type VerdictFailure = typeof VerdictFailure.Type;

/** The verdict failure's tag, as failure codes name it. */
const verdictFailureName = VerdictFailure.match({
  Rejected: () => "Rejected" as const,
  NoVerdict: () => "NoVerdict" as const,
  NotFinished: () => "NotFinished" as const,
  ModelSelectionRequired: () => "ModelSelectionRequired" as const,
  Unavailable: () => "Unavailable" as const,
});

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
] as const satisfies readonly (keyof (typeof CardWorktreeFailedReason)["cases"])[]);

/** Why one attempt or verification of a card failed. */
export const CardFailure = Schema.TaggedUnion({
  Agent: { code: AgentFailureCode },
  Worktree: { reason: WorktreeFailureReason },
  Verification: { verdict: VerdictFailure },
  /** The Goal branch moved during every verification round. */
  GoalBranchKeptMoving: {},
  Defect: {},
});
export type CardFailure = typeof CardFailure.Type;

export const worktreeFailure = (failure: CardWorktreeFailed): CardFailure =>
  CardFailure.cases.Worktree.make({ reason: cardWorktreeFailedReasonName(failure.reason) });

/** Why the loop stopped or delayed a card, as the board shows it. */
export const CardHoldReason = Schema.TaggedUnion({
  RetryBackoff: { failure: CardFailure },
  /** The orchestrator model replaces the card; no failure when a person asked for it. */
  ReplanRequested: { failure: Schema.NullOr(CardFailure) },
  RepeatedFailure: { failure: CardFailure },
  MergeConflict: { files: Schema.Array(Schema.String) },
  UncertainEffect: { runId: Schema.String },
  /** The card's queue item ran out of deliveries. */
  DeadLettered: {},
  /** The orchestrator model stopped the card or asks a person about it after a Goal change. */
  GoalChanged: { note: Schema.String },
  UpstreamRegressed: { verdict: VerdictFailure },
});
export type CardHoldReason = typeof CardHoldReason.Type;

/** The failure as revision details and logs name it: tags only, never a model's words. */
export const failureCode = CardFailure.match({
  Agent: (failure) => `agent_${failure.code}`,
  Worktree: (failure) => `worktree_${failure.reason}`,
  Verification: (failure) => `verification_${verdictFailureName(failure.verdict)}`,
  GoalBranchKeptMoving: () => "goal_branch_kept_moving",
  Defect: () => "defect",
});
