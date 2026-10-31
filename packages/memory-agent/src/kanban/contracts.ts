import { Schema } from "effect";
import { LoopHealth } from "../runtime/loop-health.ts";
import { CardStatus } from "../workflow/card.ts";
import { CardHoldReason, VerdictFailure } from "./failures.ts";
import { DecisionKind } from "./human-decision-schema.ts";

/**
 * Kanban boards, decisions and project kanban settings as the page reads and answers them. This
 * module imports no server code, so the browser bundle can use it; `human-decision.ts`,
 * `goal-schedules.ts`, `card-attempts.ts` and `board-actions.ts` keep them.
 */

/** Branches a project's Goals never merge into on their own. */
export const ProtectedBranches = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)),
);

/** A person's answer; its tag must be the request's kind. */
export const DecisionAnswer = Schema.TaggedUnion({
  UncertainSideEffect: { choice: Schema.Literals(["continue", "retry", "stop"]) },
  IntegrationConflict: { choice: Schema.Literals(["resolved", "rework", "stop"]) },
  ImpactUnclear: { choice: Schema.Literals(["continue", "replace", "stop"]) },
  RetryExhausted: { choice: Schema.Literals(["requeue", "stop"]) },
  ProtectedBranchMerge: { choice: Schema.Literals(["create_pr", "manual_merge"]) },
  MergeConflict: { choice: Schema.Literals(["resolved", "stop"]) },
  FileOverlap: { choice: Schema.Literals(["wait", "proceed"]) },
});
export type DecisionAnswer = typeof DecisionAnswer.Type;

/** Why a wait ended without an answer. A close is never an answer, and never a refusal. */
export const DecisionCloseReason = Schema.Literals([
  "orchestrator_cancelled",
  "goal_replaced",
  "card_stopped",
]);
export type DecisionCloseReason = typeof DecisionCloseReason.Type;

const State = Schema.TaggedUnion({
  Pending: {},
  Answered: { answer: DecisionAnswer },
  Closed: { reason: Schema.NullOr(DecisionCloseReason) },
});
export type DecisionState = typeof State.Type;

export const HumanDecisionRequest = Schema.Struct({
  requestId: Schema.String,
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  /** The latest facts the orchestrator saw at the occasion. */
  kind: DecisionKind,
  /** Which facts `kind` is, counting from 1; an answer names it. */
  factsSeq: Schema.Finite,
  /** The facts changed after the request first asked. */
  factsChanged: Schema.Boolean,
  createdAt: Schema.Finite,
  state: State,
});
export type HumanDecisionRequest = typeof HumanDecisionRequest.Type;

/** An unanswered request in a project's inbox, with names to show it by. */
export const DecisionInboxItem = Schema.Struct({
  ...HumanDecisionRequest.fields,
  sessionTitle: Schema.NullOr(Schema.String),
  cardTitle: Schema.String,
});
export type DecisionInboxItem = typeof DecisionInboxItem.Type;

/** Where a Goal's merge into its target branch stands. Only metadata, never provider text. */
export const GoalMergeState = Schema.TaggedUnion({
  /** The Goal branch at `head` is being checked as a whole. */
  Verifying: { head: Schema.String },
  /** The Goal-level check failed at `head`; a new Goal branch commit is checked again. */
  VerifyFailed: { head: Schema.String, verdict: VerdictFailure },
  /** The target is checked out with uncommitted changes there; the merge waits for them. */
  WaitingWorktree: { head: Schema.String, worktree: Schema.String },
  /** The target kept moving while the merge ran; the next look tries again. */
  TargetMoving: {},
  /** A person decides (protected branch or conflict); the request names the wait. */
  AwaitingDecision: { requestId: Schema.String },
  Merged: { commit: Schema.String },
  /** The person merges by hand; the Goal branch stays. */
  ManualMerge: {},
  /** The push and pull request ran without a recorded result. Never run again on its own. */
  PullRequestPending: {},
  PullRequestCreated: { url: Schema.String },
  /** The owner stopped while a pull request was being made; a person checks what happened. */
  PullRequestUncertain: {},
  PullRequestFailed: { stage: Schema.Literals(["push", "create"]) },
  Stopped: {
    reason: Schema.Literals(["no_target", "target_missing", "conflict_stopped", "goal_replaced"]),
  },
});
export type GoalMergeState = typeof GoalMergeState.Type;

/** A Goal instance stopped by the orchestrator until its cards are classified against a new Goal. */
export const AssignmentHold = Schema.TaggedStruct("GoalChanged", {
  fromVersion: Schema.Int,
  toVersion: Schema.Int,
});
export type AssignmentHold = typeof AssignmentHold.Type;

export const KanbanMode = Schema.Literals(["worktree", "sequential"]);
export type KanbanMode = typeof KanbanMode.Type;

/** What the loop knows about a card beyond the Plan. */
export const KanbanCardView = Schema.Struct({
  cardId: Schema.String,
  status: CardStatus,
  /** Why the loop stopped or delayed the card. */
  reason: Schema.NullOr(CardHoldReason),
  failures: Schema.Finite,
  replans: Schema.Finite,
  /** The card a resolution card re-applies. */
  resolutionOf: Schema.NullOr(Schema.String),
  requeueable: Schema.Boolean,
});
export type KanbanCardView = typeof KanbanCardView.Type;

/** Another kanban Goal of the project, as a Goal this one can wait for. */
export const KanbanGoalOption = Schema.Struct({
  goalInstanceId: Schema.String,
  sessionId: Schema.String,
  sessionTitle: Schema.NullOr(Schema.String),
  statement: Schema.NullOr(Schema.String),
  merge: Schema.NullOr(GoalMergeState),
});
export type KanbanGoalOption = typeof KanbanGoalOption.Type;

/**
 * How the project scheduler treats the board's Goal. Its place in the priority tree is the
 * project board's business (`GoalOrder`), not the Goal's own.
 */
export const KanbanScheduleView = Schema.Struct({
  /** The branch the Goal merges into; none when the board started on a detached HEAD. */
  targetBranch: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  /** The Goals it depends on that have not merged yet; while any remain it takes no slots. */
  waitingOn: Schema.Array(Schema.String),
  merge: Schema.NullOr(GoalMergeState),
  upstreamPending: Schema.Boolean,
  otherGoals: Schema.Array(KanbanGoalOption),
});
export type KanbanScheduleView = typeof KanbanScheduleView.Type;

/** The session's kanban board as the loop sees it. */
export const KanbanBoardView = Schema.Struct({
  goalInstanceId: Schema.String,
  mode: KanbanMode,
  goalChange: Schema.NullOr(AssignmentHold),
  cards: Schema.Array(KanbanCardView),
  schedule: Schema.NullOr(KanbanScheduleView),
  /** How the board's loop stands; a stopped one waits for `restartLoop`. */
  loop: LoopHealth,
});
export type KanbanBoardView = typeof KanbanBoardView.Type;

/** A Goal that started running as a kanban board, and how its cards run. */
export const KanbanStarted = Schema.Struct({ goalInstanceId: Schema.String, mode: KanbanMode });
export type KanbanStarted = typeof KanbanStarted.Type;
