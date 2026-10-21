import { Effect, Schema, Struct, type Types } from "effect";
import { CardRisk, cardContractKeys, type BoardAuthor, type CardStatus } from "./card.ts";
import {
  notStartedStatus,
  validatePlanDependencies,
  type PlanDependenciesRejected,
} from "./plan-schedule.ts";
import type { PlanArtifact, PlanStep, WorkflowState } from "./workflow.ts";

const CardText = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isMinLength(1)));

/** A card the user adds; the owner gives it its id and status. */
export const CardDraft = Schema.Struct({
  title: CardText,
  description: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
  boundaries: Schema.optionalKey(Schema.Array(Schema.String)),
  risk: Schema.optionalKey(CardRisk),
  requiredEvidence: Schema.optionalKey(Schema.Array(Schema.String)),
  humanDecision: Schema.optionalKey(Schema.String),
});
export type CardDraft = typeof CardDraft.Type;

/** Fields the user changes on a card. An absent key keeps the value; null clears a contract field. */
export const CardPatch = Schema.Struct({
  title: Schema.optionalKey(CardText),
  description: Schema.optionalKey(Schema.String),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(Schema.String)),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  boundaries: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  risk: Schema.optionalKey(Schema.NullOr(CardRisk)),
  requiredEvidence: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  humanDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CardPatch = typeof CardPatch.Type;

const Index = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

/** A user's board change. `planVersion` is the Plan the user saw; a newer one refuses it. */
export const BoardEdit = Schema.Union([
  Schema.TaggedStruct("AddCard", {
    planVersion: Schema.Int,
    card: CardDraft,
    index: Schema.optionalKey(Index),
  }),
  Schema.TaggedStruct("EditCard", {
    planVersion: Schema.Int,
    cardId: Schema.String,
    patch: CardPatch,
  }),
  Schema.TaggedStruct("MoveCard", { planVersion: Schema.Int, cardId: Schema.String, index: Index }),
  Schema.TaggedStruct("CancelCard", { planVersion: Schema.Int, cardId: Schema.String }),
]);
export type BoardEdit = typeof BoardEdit.Type;

/** What a user asked of an executing card; the orchestrator settles it. */
export const UserChange = Schema.Union([
  Schema.TaggedStruct("Edit", { patch: CardPatch }),
  Schema.TaggedStruct("Cancel", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type UserChange = typeof UserChange.Type;

export const UserChangeRequestStatus = Schema.Literals([
  "pending",
  "applied",
  "reassigned",
  "rejected",
]);

export const UserChangeRequest = Schema.Struct({
  id: Schema.Int,
  cardId: Schema.String,
  planVersion: Schema.Int,
  change: UserChange,
  status: UserChangeRequestStatus,
  reason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type UserChangeRequest = typeof UserChangeRequest.Type;

/** Answer to a board change: the saved state, or the request stored for an executing card. */
export type BoardEditResult =
  | { readonly _tag: "Applied"; readonly state: WorkflowState }
  | { readonly _tag: "Requested"; readonly request: UserChangeRequest };

export class BoardEditRefused extends Schema.TaggedError<BoardEditRefused>()("BoardEditRefused", {
  reason: Schema.Literals([
    "plan_missing",
    "plan_closed",
    "plan_version_conflict",
    "card_missing",
    "card_finished",
    "card_status_changed",
    "card_transition_invalid",
    "card_not_waiting",
    "card_held",
    "card_not_held",
  ]),
}) {}

/** A change the owner saves on the Plan, or a request it stores for an executing card. */
export type BoardEditPlan =
  | { readonly _tag: "Apply"; readonly plan: PlanArtifact; readonly detail: string }
  | { readonly _tag: "Request"; readonly cardId: string; readonly change: UserChange };

/** Executing cards are the orchestrator's; a user change to one waits as a request. */
const waitsForOrchestrator = (author: BoardAuthor, status: CardStatus) => {
  switch (author._tag) {
    case "User":
      return status === "in_progress";
    case "Orchestrator":
      return false;
  }
};

/** A patched contract field: absent keeps it, null clears it. */
const field = <A>(current: A | undefined, next: A | null | undefined) =>
  next === undefined ? current : (next ?? undefined);

const patched = (card: PlanStep, patch: CardPatch): PlanStep => {
  const { outcome, boundaries, risk, requiredEvidence, humanDecision, ...core } = patch;
  const next: Types.Mutable<PlanStep> = { ...Struct.omit(card, cardContractKeys), ...core };
  const nextOutcome = field(card.outcome, outcome);
  if (nextOutcome !== undefined) next.outcome = nextOutcome;
  const nextBoundaries = field(card.boundaries, boundaries);
  if (nextBoundaries !== undefined) next.boundaries = nextBoundaries;
  const nextRisk = field(card.risk, risk);
  if (nextRisk !== undefined) next.risk = nextRisk;
  const nextEvidence = field(card.requiredEvidence, requiredEvidence);
  if (nextEvidence !== undefined) next.requiredEvidence = nextEvidence;
  const nextDecision = field(card.humanDecision, humanDecision);
  if (nextDecision !== undefined) next.humanDecision = nextDecision;
  return next;
};

/** A card not started yet moves between backlog and ready with its dependencies. */
const restatus = (steps: readonly PlanStep[], card: PlanStep): PlanStep => {
  switch (card.status) {
    case "backlog":
    case "ready": {
      const done = new Set(steps.filter((step) => step.status === "done").map((step) => step.id));
      return { ...card, status: notStartedStatus(steps, (id) => done.has(id))(card) };
    }
    case "in_progress":
    case "verify":
    case "human_decision":
    case "done":
    case "blocked":
      return card;
  }
};

const replace = (steps: readonly PlanStep[], card: PlanStep) => {
  const next = steps.map((step) => (step.id === card.id ? card : step));
  return next.map((step) => (step.id === card.id ? restatus(next, step) : step));
};

const moved = (steps: readonly PlanStep[], from: number, index: number) => {
  const next = [...steps];
  const [card] = next.splice(from, 1);
  next.splice(Math.min(index, next.length), 0, ...(card === undefined ? [] : [card]));
  return next;
};

/**
 * Plans a user's board change against the current Plan. Dependencies are checked with the same
 * rules as update_plan; a refused change saves nothing.
 */
export const planBoardEdit = Effect.fnUntraced(function* (
  plan: PlanArtifact | null,
  edit: BoardEdit,
  author: BoardAuthor,
  newCardId: string,
): Effect.fn.Return<BoardEditPlan, BoardEditRefused | PlanDependenciesRejected> {
  if (plan === null) return yield* BoardEditRefused.make({ reason: "plan_missing" });
  if (plan.status === "completed") return yield* BoardEditRefused.make({ reason: "plan_closed" });
  if (plan.version !== edit.planVersion)
    return yield* BoardEditRefused.make({ reason: "plan_version_conflict" });
  const applied = Effect.fnUntraced(function* (steps: readonly PlanStep[], detail: string) {
    yield* validatePlanDependencies(steps);
    return { _tag: "Apply" as const, plan: { ...plan, steps, version: plan.version + 1 }, detail };
  });
  switch (edit._tag) {
    case "AddCard": {
      const card: PlanStep = {
        ...edit.card,
        id: newCardId,
        ruleRefs: [],
        status: "backlog",
        evidence: [],
      };
      const steps = [...plan.steps];
      steps.splice(Math.min(edit.index ?? steps.length, steps.length), 0, card);
      return yield* applied(replace(steps, card), `card ${newCardId} added`);
    }
    case "MoveCard": {
      const from = plan.steps.findIndex((step) => step.id === edit.cardId);
      if (from < 0) return yield* BoardEditRefused.make({ reason: "card_missing" });
      return yield* applied(
        moved(plan.steps, from, edit.index),
        `card ${edit.cardId} moved to ${edit.index + 1}`,
      );
    }
    case "EditCard":
    case "CancelCard": {
      const card = plan.steps.find((step) => step.id === edit.cardId);
      if (card === undefined) return yield* BoardEditRefused.make({ reason: "card_missing" });
      if (card.status === "done") return yield* BoardEditRefused.make({ reason: "card_finished" });
      const change: UserChange =
        edit._tag === "EditCard" ? { _tag: "Edit", patch: edit.patch } : { _tag: "Cancel" };
      if (waitsForOrchestrator(author, card.status)) {
        // A request is checked now, so the orchestrator never receives a change it cannot apply.
        if (change._tag === "Edit")
          yield* validatePlanDependencies(replace(plan.steps, patched(card, change.patch)));
        return { _tag: "Request" as const, cardId: card.id, change };
      }
      switch (change._tag) {
        case "Edit":
          return yield* applied(
            replace(plan.steps, patched(card, change.patch)),
            `card ${card.id} edited`,
          );
        case "Cancel":
          return yield* applied(
            plan.steps.filter((step) => step.id !== card.id),
            `card ${card.id} cancelled`,
          );
      }
    }
  }
});

/**
 * Status moves an author may make on a card. `done` is final. A move to `backlog` or `ready` lands
 * on whichever of the two the card's dependencies allow.
 */
export const cardTransitions = {
  backlog: ["ready", "human_decision", "blocked"],
  ready: ["backlog", "in_progress", "human_decision", "blocked"],
  in_progress: ["ready", "verify", "human_decision", "blocked"],
  verify: ["ready", "in_progress", "done", "human_decision", "blocked"],
  human_decision: ["backlog", "ready", "in_progress", "verify", "done", "blocked"],
  blocked: ["backlog", "ready", "human_decision"],
  done: [],
} as const satisfies { readonly [From in CardStatus]: readonly CardStatus[] };

/** A card status move. `from` is the status the author saw; a card that moved since is refused. */
export interface CardTransition {
  readonly cardId: string;
  readonly from: CardStatus;
  readonly to: CardStatus;
  /** Ledger text; the move itself is described when absent. */
  readonly detail?: string;
}

/** Cards not started yet follow their dependencies after a move. */
const restatusAll = (steps: readonly PlanStep[]) => steps.map((step) => restatus(steps, step));

/**
 * Plans a card status move against the current Plan. It keeps the Plan version: a status move is
 * progress, not a change of the Plan the user edits against.
 */
export const planCardTransition = Effect.fnUntraced(function* (
  plan: PlanArtifact | null,
  transition: CardTransition,
): Effect.fn.Return<{ readonly plan: PlanArtifact; readonly detail: string }, BoardEditRefused> {
  if (plan === null) return yield* BoardEditRefused.make({ reason: "plan_missing" });
  if (plan.status === "completed") return yield* BoardEditRefused.make({ reason: "plan_closed" });
  const card = plan.steps.find((step) => step.id === transition.cardId);
  if (card === undefined) return yield* BoardEditRefused.make({ reason: "card_missing" });
  if (card.status !== transition.from)
    return yield* BoardEditRefused.make({ reason: "card_status_changed" });
  const allowed: readonly CardStatus[] = cardTransitions[transition.from];
  if (!allowed.includes(transition.to))
    return yield* BoardEditRefused.make({ reason: "card_transition_invalid" });
  const steps = restatusAll(
    plan.steps.map((step) => (step.id === card.id ? { ...step, status: transition.to } : step)),
  );
  return {
    plan: { ...plan, steps },
    detail: transition.detail ?? `card ${card.id} ${transition.from} -> ${transition.to}`,
  };
});

/**
 * Puts a card on hold or releases it. Only a card not started yet is held: it stays in backlog,
 * and the loop never assigns it, until released. Like a status move it keeps the Plan version.
 */
export const planCardHold = Effect.fnUntraced(function* (
  plan: PlanArtifact | null,
  change: { readonly cardId: string; readonly hold: boolean },
  author: BoardAuthor,
  at: string,
): Effect.fn.Return<{ readonly plan: PlanArtifact; readonly detail: string }, BoardEditRefused> {
  if (plan === null) return yield* BoardEditRefused.make({ reason: "plan_missing" });
  if (plan.status === "completed") return yield* BoardEditRefused.make({ reason: "plan_closed" });
  const card = plan.steps.find((step) => step.id === change.cardId);
  if (card === undefined) return yield* BoardEditRefused.make({ reason: "card_missing" });
  if (change.hold) {
    if (card.hold !== undefined) return yield* BoardEditRefused.make({ reason: "card_held" });
    if (card.status !== "backlog" && card.status !== "ready")
      return yield* BoardEditRefused.make({ reason: "card_not_waiting" });
  } else if (card.hold === undefined)
    return yield* BoardEditRefused.make({ reason: "card_not_held" });
  const released: PlanStep = Struct.omit(card, ["hold"]);
  const next: PlanStep = change.hold ? { ...released, hold: { by: author, at } } : released;
  return {
    plan: {
      ...plan,
      steps: restatusAll(plan.steps.map((step) => (step.id === card.id ? next : step))),
    },
    detail: `card ${card.id} ${change.hold ? "held" : "released"}`,
  };
});

/**
 * What a person means by dragging a card on the board. The board turns a drop into one of these;
 * the owner decides the card's status from it.
 */
export const BoardIntent = Schema.Union([
  /** Same column: the card takes the place of `at`, which ranks it in the Goal's queue. */
  Schema.TaggedStruct("Reorder", { cardId: Schema.String, at: Schema.String }),
  /** A blocked card goes back on the queue with a fresh attempt record. */
  Schema.TaggedStruct("Requeue", { cardId: Schema.String }),
  Schema.TaggedStruct("Hold", { cardId: Schema.String }),
  Schema.TaggedStruct("Release", { cardId: Schema.String }),
  /** A change to an executing card, which the orchestrator settles. */
  Schema.TaggedStruct("ChangeRequest", { cardId: Schema.String, patch: CardPatch }),
  Schema.TaggedStruct("Cancel", { cardId: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type BoardIntent = typeof BoardIntent.Type;
