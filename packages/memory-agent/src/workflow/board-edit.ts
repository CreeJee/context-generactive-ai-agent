import { Data, Effect, Match, Schema, Struct } from "effect";
import { optionalProperty } from "../optional-property.ts";
import { BoardAuthor, cardContractKeys, type CardStatus } from "./card.ts";
import {
  BoardEdit,
  CardPatch,
  UserChange,
  type BoardEditResultCases,
  type PlanArtifact,
  type PlanStep,
} from "./contracts.ts";
import {
  notStartedStatus,
  validatePlanDependencies,
  type PlanDependenciesRejected,
} from "./plan-schedule.ts";

export {
  BoardEdit,
  BoardIntent,
  CardDraft,
  CardPatch,
  UserChange,
  UserChangeRequest,
  UserChangeRequestStatus,
} from "./contracts.ts";

/** Answer to a board change: the saved state, or the request stored for an executing card. */
export type BoardEditResult = BoardEditResultCases;
export const BoardEditResult = Data.taggedEnum<BoardEditResult>();

export class BoardEditRefused extends Schema.TaggedError<
  BoardEditRefused,
  { readonly brand: unique symbol }
>()("BoardEditRefused", {
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

/**
 * A change the owner saves on the Plan, a request it stores for an executing card, or the Plan's
 * end without completion.
 */
export type BoardEditPlan = Data.TaggedEnum<{
  Apply: { readonly plan: PlanArtifact; readonly detail: string };
  Request: { readonly cardId: string; readonly change: UserChange };
  Close: { readonly plan: PlanArtifact; readonly detail: string };
}>;
export const BoardEditPlan = Data.taggedEnum<BoardEditPlan>();

/** A completed or closed Plan takes no more changes. */
export const planEnded = (plan: PlanArtifact) =>
  plan.status === "completed" || plan.status === "closed";

/**
 * Ends a Plan without completing it. Done cards keep their evidence; every other card stays on the
 * Plan as blocked and released, so nothing assigns it again. The version stays: closing is not a
 * change of the cards a user edits against.
 */
export const closedPlan = (plan: PlanArtifact): PlanArtifact => ({
  ...plan,
  status: "closed",
  steps: plan.steps.map((step) =>
    step.status === "done" ? step : { ...Struct.omit(step, ["hold"]), status: "blocked" },
  ),
});

/** Executing cards are the orchestrator's; a user change to one waits as a request. */
const waitsForOrchestrator = (author: BoardAuthor, status: CardStatus) =>
  BoardAuthor.match(author, {
    User: () => status === "in_progress",
    Orchestrator: () => false,
  });

/** A patched contract field: absent keeps it, null clears it. */
const field = <A>(current: A | undefined, next: A | null | undefined) =>
  next === undefined ? current : (next ?? undefined);

const patched = (card: PlanStep, patch: CardPatch): PlanStep => {
  const { outcome, boundaries, risk, requiredEvidence, humanDecision, ...core } = patch;
  return {
    ...Struct.omit(card, cardContractKeys),
    ...core,
    ...optionalProperty("outcome", field(card.outcome, outcome)),
    ...optionalProperty("boundaries", field(card.boundaries, boundaries)),
    ...optionalProperty("risk", field(card.risk, risk)),
    ...optionalProperty("requiredEvidence", field(card.requiredEvidence, requiredEvidence)),
    ...optionalProperty("humanDecision", field(card.humanDecision, humanDecision)),
  };
};

/** A card not started yet moves between backlog and ready with its dependencies. */
const restatus = (steps: readonly PlanStep[], card: PlanStep): PlanStep =>
  Match.value(card.status).pipe(
    Match.whenOr("backlog", "ready", (): PlanStep => {
      const done = new Set(steps.filter((step) => step.status === "done").map((step) => step.id));
      return { ...card, status: notStartedStatus(steps, (id) => done.has(id))(card) };
    }),
    Match.whenOr("in_progress", "verify", "human_decision", "done", "blocked", () => card),
    Match.exhaustive,
  );

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
  if (planEnded(plan)) return yield* BoardEditRefused.make({ reason: "plan_closed" });
  if (plan.version !== edit.planVersion)
    return yield* BoardEditRefused.make({ reason: "plan_version_conflict" });
  const applied = Effect.fnUntraced(function* (
    steps: readonly PlanStep[],
    detail: string,
  ): Effect.fn.Return<BoardEditPlan, PlanDependenciesRejected> {
    yield* validatePlanDependencies(steps);
    return BoardEditPlan.Apply({ plan: { ...plan, steps, version: plan.version + 1 }, detail });
  });
  const changeCard = Effect.fnUntraced(function* (cardId: string, change: UserChange) {
    const card = plan.steps.find((step) => step.id === cardId);
    if (card === undefined) return yield* BoardEditRefused.make({ reason: "card_missing" });
    if (card.status === "done") return yield* BoardEditRefused.make({ reason: "card_finished" });
    if (waitsForOrchestrator(author, card.status)) {
      // A request is checked now, so the orchestrator never receives a change it cannot apply.
      yield* UserChange.match(change, {
        Edit: ({ patch }) => validatePlanDependencies(replace(plan.steps, patched(card, patch))),
        Cancel: () => Effect.void,
      });
      return BoardEditPlan.Request({ cardId: card.id, change });
    }
    return yield* UserChange.match(change, {
      Edit: ({ patch }) =>
        applied(replace(plan.steps, patched(card, patch)), `card ${card.id} edited`),
      Cancel: () =>
        applied(
          plan.steps.filter((step) => step.id !== card.id),
          `card ${card.id} cancelled`,
        ),
    });
  });
  return yield* BoardEdit.match(edit, {
    AddCard: Effect.fnUntraced(function* ({ card: draft, index }) {
      const card: PlanStep = {
        ...draft,
        id: newCardId,
        ruleRefs: [],
        status: "backlog",
        evidence: [],
      };
      const steps = [...plan.steps];
      steps.splice(Math.min(index ?? steps.length, steps.length), 0, card);
      return yield* applied(replace(steps, card), `card ${newCardId} added`);
    }),
    MoveCard: Effect.fnUntraced(function* ({ cardId, index }) {
      const from = plan.steps.findIndex((step) => step.id === cardId);
      if (from < 0) return yield* BoardEditRefused.make({ reason: "card_missing" });
      return yield* applied(moved(plan.steps, from, index), `card ${cardId} moved to ${index + 1}`);
    }),
    EditCard: ({ cardId, patch }) => changeCard(cardId, UserChange.cases.Edit.make({ patch })),
    CancelCard: ({ cardId }) => changeCard(cardId, UserChange.cases.Cancel.make({})),
    ClosePlan: () =>
      Effect.succeed(
        BoardEditPlan.Close({ plan: closedPlan(plan), detail: `plan v${plan.version} closed` }),
      ),
  });
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
  if (planEnded(plan)) return yield* BoardEditRefused.make({ reason: "plan_closed" });
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
  if (planEnded(plan)) return yield* BoardEditRefused.make({ reason: "plan_closed" });
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
