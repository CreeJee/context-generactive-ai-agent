import { Schema } from "effect";
import { DecisionKind } from "./human-decision-schema.ts";

/**
 * Kanban decisions and project kanban settings as the page reads and answers them. This module
 * imports no server code, so the browser bundle can use it; `human-decision.ts` and
 * `goal-schedules.ts` keep them.
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
