import { Schema, Struct } from "effect";

/** Kanban lifecycle of a Plan step (a board card). */
export const CardStatus = Schema.Literals([
  "backlog",
  "ready",
  "in_progress",
  "verify",
  "human_decision",
  "done",
  "blocked",
]);
export type CardStatus = typeof CardStatus.Type;

/** Step statuses of the update_workflow_progress contract and of Plans saved before cards. */
export const StepProgressStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);
export type StepProgressStatus = typeof StepProgressStatus.Type;

const progressOfCard = {
  backlog: "pending",
  ready: "pending",
  in_progress: "in_progress",
  verify: "in_progress",
  human_decision: "blocked",
  blocked: "blocked",
  done: "completed",
} as const satisfies Record<CardStatus, StepProgressStatus>;

/** How a card reads in the model-facing progress vocabulary, which Goal execution keeps. */
export function stepProgressStatus(status: CardStatus): StepProgressStatus {
  return progressOfCard[status];
}

export const CardRisk = Schema.Literals(["low", "medium", "high"]);
export type CardRisk = typeof CardRisk.Type;

/**
 * Optional card contract. `requiredEvidence` is the evidence the orchestrator picks for the
 * card's risk; the step's `evidence` stays the evidence actually recorded.
 */
export const cardContractFields = {
  boundaries: Schema.optionalKey(Schema.Array(Schema.String)),
  risk: Schema.optionalKey(CardRisk),
  requiredEvidence: Schema.optionalKey(Schema.Array(Schema.String)),
  humanDecision: Schema.optionalKey(Schema.String),
} as const;

export const cardContractKeys = [
  "boundaries",
  "risk",
  "requiredEvidence",
  "humanDecision",
] as const satisfies ReadonlyArray<keyof typeof cardContractFields>;

/** The contract fields a card carries, kept when the model replans the same step id. */
export const cardContract = <S extends Schema.Struct.Type<typeof cardContractFields>>(card: S) =>
  Struct.pick(card, cardContractKeys);

/** Who changed the board; recorded with every board revision. */
export const BoardAuthor = Schema.TaggedUnion({
  User: {},
  Orchestrator: { runId: Schema.String },
});
export type BoardAuthor = typeof BoardAuthor.Type;

/**
 * A card a person or the orchestrator put on hold: it stays in backlog while held, even once its
 * dependencies are done, so the loop never assigns it. Releasing it lets it follow them again.
 */
export const CardHold = Schema.Struct({ by: BoardAuthor, at: Schema.String });
export type CardHold = typeof CardHold.Type;

/** The auto permission mode's reviewer would not approve a card; the user decides it. */
export const CardApprovalReview = Schema.Struct({
  decision: Schema.Literals(["ask", "block"]),
  reason: Schema.String,
});
export type CardApprovalReview = typeof CardApprovalReview.Type;

/**
 * A card the planner added to a running board, waiting for approval: like a held card it stays in
 * backlog and is never assigned until approved. The board approves it at once, through the auto
 * permission mode's reviewer, or by the user, as the board's approval policy says.
 */
export const CardApproval = Schema.Struct({
  requestedBy: BoardAuthor,
  at: Schema.String,
  review: Schema.optionalKey(CardApprovalReview),
});
export type CardApproval = typeof CardApproval.Type;

/** The fields a card keeps when the model replans the same step id, besides its contract. */
export const cardHoldFields = {
  hold: Schema.optionalKey(CardHold),
  approval: Schema.optionalKey(CardApproval),
} as const;

/** Whether nothing keeps a card that is not started from following its dependencies. */
export const cardWaitsForNobody = (card: {
  readonly hold?: CardHold;
  readonly approval?: CardApproval;
}) => card.hold === undefined && card.approval === undefined;
