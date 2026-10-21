import { Effect, Match, Option } from "effect";
import { BoardEdit, type CardDraft, type CardPatch } from "../workflow/board-edit.ts";
import type { BoardAuthor } from "../workflow/card.ts";
import type { PlanStep, Workflows } from "../workflow/workflow.ts";

/**
 * Board edits the orchestrator composes from single card changes. Each change is checked and
 * saved against the Plan as it is at that moment, so a change made meanwhile is never overwritten.
 */
export const boardOps = (workflows: Workflows["Service"]) => {
  /** Adds a card and returns it as saved, with the id the owner gave it. */
  const addCard = Effect.fnUntraced(function* (
    sessionId: string,
    card: CardDraft,
    author: BoardAuthor,
  ) {
    const before = yield* workflows.get(sessionId);
    const known = new Set(before.plan?.steps.map((step) => step.id) ?? []);
    const result = yield* workflows.editBoard(
      sessionId,
      // The draft is not checked here: a resolution card copies a stored title as it is.
      BoardEdit.cases.AddCard.make(
        { planVersion: before.plan?.version ?? 0, card },
        { disableChecks: true },
      ),
      author,
    );
    return Match.valueTags(result, {
      Applied: ({ state }) =>
        Option.fromUndefinedOr(state.plan?.steps.find((step) => !known.has(step.id))),
      Requested: () => Option.none<PlanStep>(),
    });
  });

  const editCard = Effect.fnUntraced(function* (
    sessionId: string,
    cardId: string,
    patch: CardPatch,
    author: BoardAuthor,
  ) {
    const current = yield* workflows.get(sessionId);
    return yield* workflows.editBoard(
      sessionId,
      BoardEdit.cases.EditCard.make({ planVersion: current.plan?.version ?? 0, cardId, patch }),
      author,
    );
  });

  const cancelCard = Effect.fnUntraced(function* (
    sessionId: string,
    cardId: string,
    author: BoardAuthor,
  ) {
    const current = yield* workflows.get(sessionId);
    return yield* workflows.editBoard(
      sessionId,
      BoardEdit.cases.CancelCard.make({ planVersion: current.plan?.version ?? 0, cardId }),
      author,
    );
  });

  /**
   * Points every card that depends on one of `replaced` at `replacements` instead, then takes the
   * replaced cards off the board.
   */
  const replaceCards = Effect.fnUntraced(function* (
    sessionId: string,
    replaced: readonly string[],
    replacements: readonly string[],
    author: BoardAuthor,
  ) {
    const gone = new Set(replaced);
    const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
    const dependents = steps.filter(
      (step) => !gone.has(step.id) && step.dependsOn.some((id) => gone.has(id)),
    );
    const dependsOn = new Map(steps.map((step) => [step.id, step.dependsOn]));
    // A replaced card another replaced card depends on is cancelled after it.
    const order: string[] = [];
    let remaining = [...replaced];
    while (remaining.length > 0) {
      const leaf = remaining.find(
        (id) => !remaining.some((other) => other !== id && dependsOn.get(other)?.includes(id)),
      );
      // A cycle among them cannot be cancelled in any order; the refusal names it.
      const next = leaf === undefined ? remaining : [leaf];
      order.push(...next);
      remaining = remaining.filter((id) => !next.includes(id));
    }
    yield* Effect.forEach(
      dependents,
      (step) =>
        editCard(
          sessionId,
          step.id,
          {
            dependsOn: [
              ...new Set(step.dependsOn.flatMap((id) => (gone.has(id) ? replacements : [id]))),
            ],
          },
          author,
        ),
      { discard: true },
    );
    yield* Effect.forEach(order, (cardId) => cancelCard(sessionId, cardId, author), {
      discard: true,
    });
  });

  return { addCard, editCard, cancelCard, replaceCards };
};
