import { Array as Arr, Effect, HashSet, Iterable, Schema } from "effect";
import { type GoalOutcome, OutcomeId, type PlanStep } from "./contracts.ts";

/** A step that names an outcome id the current Goal does not have. */
export const UnknownStepOutcome = Schema.Struct({ stepId: Schema.String, outcomeId: OutcomeId });
export type UnknownStepOutcome = typeof UnknownStepOutcome.Type;

/** A Plan change refused because its steps name outcomes the current Goal does not have. */
export class PlanOutcomesRejected extends Schema.TaggedError<
  PlanOutcomesRejected,
  { readonly brand: unique symbol }
>()("PlanOutcomesRejected", { unknown: Schema.NonEmptyArray(UnknownStepOutcome) }) {}

/** The refusal as the model reads it. */
export const unknownStepOutcomeText = ({ stepId, outcomeId }: UnknownStepOutcome) =>
  `step ${stepId} names outcome ${outcomeId}, which the current Goal does not have`;

type OutcomeStep = Pick<PlanStep, "id" | "outcomes">;

/** Each outcome id a step names that is not one of `outcomes`, once per step. */
const unknownStepOutcomes = (
  outcomes: readonly GoalOutcome[],
  steps: readonly OutcomeStep[],
): ReadonlyArray<UnknownStepOutcome> => {
  const ids = HashSet.fromIterable(Iterable.map(outcomes, (outcome) => outcome.id));
  return steps.flatMap((step) =>
    Arr.dedupe(step.outcomes)
      .filter((outcomeId) => !HashSet.has(ids, outcomeId))
      .map((outcomeId) => ({ stepId: step.id, outcomeId })),
  );
};

/** Plan saves refuse steps that name outcomes the current Goal does not have. */
export const validateStepOutcomes = Effect.fnUntraced(function* (
  outcomes: readonly GoalOutcome[],
  steps: readonly OutcomeStep[],
): Effect.fn.Return<void, PlanOutcomesRejected> {
  const unknown = unknownStepOutcomes(outcomes, steps);
  if (Arr.isReadonlyArrayNonEmpty(unknown)) return yield* PlanOutcomesRejected.make({ unknown });
});
