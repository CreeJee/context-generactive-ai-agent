import { Effect, Match, Schema } from "effect";
import { GoalOutcome, GoalQuestion, OutcomeId, type GoalArtifact } from "./contracts.ts";
import type { UpdateGoal } from "./workflow.ts";

/** The Goal's plain text lists an edit can change item by item. */
const GoalList = Schema.Literals(["constraints", "nonGoals", "assumptions"]).annotate({
  description: "Which list of the Goal the item is in.",
});
type GoalList = typeof GoalList.Type;

const Text = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isMinLength(1)));

/**
 * One small change to the current Goal; `action` picks it. A change names what it touches by id
 * (outcomes, questions) or by exact text (list items), so the rest of the Goal is not resent.
 */
export const GoalEdit = Schema.Union([
  Schema.Struct({ action: Schema.Literal("set_statement"), statement: Text }),
  Schema.Struct({
    action: Schema.Literal("set_status"),
    status: Schema.Literals(["draft", "active"]),
  }),
  Schema.Struct({ action: Schema.Literal("add_outcome"), outcome: GoalOutcome }),
  Schema.Struct({ action: Schema.Literal("edit_outcome"), outcomeId: OutcomeId, text: Text }),
  Schema.Struct({ action: Schema.Literal("remove_outcome"), outcomeId: OutcomeId }),
  Schema.Struct({ action: Schema.Literal("add_item"), list: GoalList, text: Text }),
  Schema.Struct({ action: Schema.Literal("edit_item"), list: GoalList, text: Text, newText: Text }),
  Schema.Struct({ action: Schema.Literal("remove_item"), list: GoalList, text: Text }),
  Schema.Struct({ action: Schema.Literal("add_question"), question: GoalQuestion }),
  Schema.Struct({
    action: Schema.Literal("edit_question"),
    questionId: Schema.String,
    question: Schema.optionalKey(Text),
    blocking: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literal("remove_question"), questionId: Schema.String }),
]);
export type GoalEdit = typeof GoalEdit.Type;

/** Changes to the Goal version the model read, applied in order and saved as its next version. */
export const EditGoal = Schema.Struct({
  goalVersion: Schema.Int,
  edits: Schema.NonEmptyArray(GoalEdit),
});
export type EditGoal = typeof EditGoal.Type;

export class GoalEditRefused extends Schema.TaggedError<
  GoalEditRefused,
  { readonly brand: unique symbol }
>()("GoalEditRefused", {
  reason: Schema.Literals([
    "goal_missing",
    "goal_version_conflict",
    "outcome_missing",
    "outcome_exists",
    "item_missing",
    "item_exists",
    "question_missing",
    "question_exists",
  ]),
  /** The 0-based position of the refused edit in the call; none when the call itself was refused. */
  edit: Schema.NullOr(Schema.Int),
}) {}

/**
 * The Goal `edits` make of `goal`, as a whole Goal to save. A refused edit saves none of the call's
 * edits. A Goal that was neither draft nor active becomes active unless an edit sets its status.
 */
export const applyGoalEdits = Effect.fnUntraced(function* (
  goal: GoalArtifact | null,
  input: EditGoal,
): Effect.fn.Return<UpdateGoal, GoalEditRefused> {
  if (goal === null) return yield* GoalEditRefused.make({ reason: "goal_missing", edit: null });
  if (goal.version !== input.goalVersion)
    return yield* GoalEditRefused.make({ reason: "goal_version_conflict", edit: null });
  const start: UpdateGoal = {
    statement: goal.statement,
    outcomes: goal.outcomes,
    constraints: goal.constraints,
    nonGoals: goal.nonGoals,
    assumptions: goal.assumptions,
    openQuestions: goal.openQuestions,
    status: goal.status === "draft" ? "draft" : "active",
  };
  return yield* Effect.reduce(
    input.edits.map((edit, index) => ({ edit, index })),
    () => start,
    (draft, { edit, index }) => applyGoalEdit(draft, edit, index),
  );
});

const applyGoalEdit = (
  draft: UpdateGoal,
  edit: GoalEdit,
  index: number,
): Effect.Effect<UpdateGoal, GoalEditRefused> => {
  const refuse = (reason: GoalEditRefused["reason"]) =>
    Effect.fail(GoalEditRefused.make({ reason, edit: index }));
  const hasOutcome = (id: string) => draft.outcomes.some((outcome) => outcome.id === id);
  const hasQuestion = (id: string) => draft.openQuestions.some((question) => question.id === id);
  const hasItem = (list: GoalList, text: string) => draft[list].includes(text);
  return Match.value(edit).pipe(
    Match.discriminatorsExhaustive("action")({
      set_statement: ({ statement }) => Effect.succeed({ ...draft, statement }),
      set_status: ({ status }) => Effect.succeed({ ...draft, status }),
      add_outcome: ({ outcome }) =>
        hasOutcome(outcome.id)
          ? refuse("outcome_exists")
          : Effect.succeed({ ...draft, outcomes: [...draft.outcomes, outcome] }),
      edit_outcome: ({ outcomeId, text }) =>
        hasOutcome(outcomeId)
          ? Effect.succeed({
              ...draft,
              outcomes: draft.outcomes.map((outcome) =>
                outcome.id === outcomeId ? { ...outcome, text } : outcome,
              ),
            })
          : refuse("outcome_missing"),
      remove_outcome: ({ outcomeId }) =>
        hasOutcome(outcomeId)
          ? Effect.succeed({
              ...draft,
              outcomes: draft.outcomes.filter((outcome) => outcome.id !== outcomeId),
            })
          : refuse("outcome_missing"),
      add_item: ({ list, text }) =>
        hasItem(list, text)
          ? refuse("item_exists")
          : Effect.succeed({ ...draft, [list]: [...draft[list], text] }),
      edit_item: ({ list, text, newText }) =>
        !hasItem(list, text)
          ? refuse("item_missing")
          : text !== newText && hasItem(list, newText)
            ? refuse("item_exists")
            : Effect.succeed({
                ...draft,
                [list]: draft[list].map((item) => (item === text ? newText : item)),
              }),
      remove_item: ({ list, text }) =>
        hasItem(list, text)
          ? Effect.succeed({ ...draft, [list]: draft[list].filter((item) => item !== text) })
          : refuse("item_missing"),
      add_question: ({ question }) =>
        hasQuestion(question.id)
          ? refuse("question_exists")
          : Effect.succeed({ ...draft, openQuestions: [...draft.openQuestions, question] }),
      edit_question: ({ questionId, question, blocking }) =>
        hasQuestion(questionId)
          ? Effect.succeed({
              ...draft,
              openQuestions: draft.openQuestions.map((open) =>
                open.id === questionId
                  ? {
                      ...open,
                      question: question ?? open.question,
                      blocking: blocking ?? open.blocking,
                    }
                  : open,
              ),
            })
          : refuse("question_missing"),
      remove_question: ({ questionId }) =>
        hasQuestion(questionId)
          ? Effect.succeed({
              ...draft,
              openQuestions: draft.openQuestions.filter((open) => open.id !== questionId),
            })
          : refuse("question_missing"),
    }),
  );
};
