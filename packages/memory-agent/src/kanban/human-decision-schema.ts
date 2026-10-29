import { Schema } from "effect";

/**
 * The stored shapes of kanban human decisions. They depend on nothing but Schema, so the database
 * migration that moves 0.0.17 rows can read them without the decision service.
 */

/** What a card waits on a person for. The metadata is safe to show: no provider text or paths. */
export const DecisionKind = Schema.TaggedUnion({
  /**
   * An attempt's run left a tool whose effect is unknown; the person says what really happened.
   * `toolNames` is empty when the run's records do not name the tools.
   */
  UncertainSideEffect: {
    runId: Schema.String,
    toolNames: Schema.Array(Schema.String),
  },
  /** Integrating the card into the Goal branch conflicted in these files. */
  IntegrationConflict: { files: Schema.Array(Schema.String) },
  /** A Goal change whose effect on the card the orchestrator could not judge (NeedsDecision). */
  ImpactUnclear: {
    fromGoalVersion: Schema.Int,
    toGoalVersion: Schema.Int,
  },
  /** Every attempt of the card failed. */
  RetryExhausted: { attempts: Schema.Int },
  /**
   * The Goal would merge into a protected branch, which is never automatic. A pull request is
   * offered only when the GitHub CLI was found when the Goal asked.
   */
  ProtectedBranchMerge: {
    targetBranch: Schema.String,
    prAvailable: Schema.Boolean,
  },
  /** Merging the user's branch into the Goal branch conflicted in these files. */
  MergeConflict: {
    targetBranch: Schema.String,
    files: Schema.Array(Schema.String),
  },
  /**
   * The card's expected files overlap a card another Goal finished but has not merged yet; the
   * scheduler cannot tell which Goal should go first.
   */
  FileOverlap: {
    otherGoalInstanceId: Schema.String,
    otherCardId: Schema.String,
    files: Schema.Array(Schema.String),
  },
});
export type DecisionKind = typeof DecisionKind.Type;

export const humanDecisionWorkflow = "HumanDecisionExecution";

/**
 * A request's identity: the same occasion of the same card is the same payload. What the
 * orchestrator saw when it asked is kept apart, as rows of `human_decision_facts`.
 */
export const HumanDecisionPayload = Schema.Struct({
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  key: Schema.String,
});
export type HumanDecisionPayload = typeof HumanDecisionPayload.Type;

/** The payload 0.0.17 stored, with the facts and the time it asked. */
export const LegacyHumanDecisionPayload = Schema.Struct({
  ...HumanDecisionPayload.fields,
  kind: DecisionKind,
  createdAt: Schema.Finite,
});
