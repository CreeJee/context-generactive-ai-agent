import { Effect, Match, Predicate, Result } from "effect";
import {
  AppEvents,
  BoardAuthor,
  BoardEdit,
  Boards,
  DecisionCloseScope,
  HumanDecisions,
  SessionLeases,
  Sessions,
  Workflows,
  sessionHolderHeader,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/sessions.$session.board";

/** GET /api/sessions/:session/board — the Plan as cards, who changed them, and waiting changes. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Sessions).get(params.session);
      return yield* (yield* Boards).view(params.session);
    }).pipe(answerKanbanFailures),
  );
}

/**
 * POST /api/sessions/:session/board { _tag, planVersion, … } — the user adds, edits, moves or
 * cancels a card. A change to an executing card is stored as a request (202) instead. Refused when
 * another page holds the session (423), the Plan changed since the page read it (409), or the
 * dependencies would break (422).
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, BoardEdit));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_board_edit" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      if (!(yield* SessionLeases).permits(params.session, holder))
        return Response.json({ error: "session_in_use" }, { status: 423 });
      yield* (yield* Sessions).get(params.session);
      const workflows = yield* Workflows;
      const result = yield* workflows.editBoard(
        params.session,
        body.success,
        BoardAuthor.cases.User.make({}),
      );
      // A stopped card's decision is closed, not answered: nobody refused it.
      if (Predicate.isTagged(result, "Applied") && BoardEdit.guards.CancelCard(body.success)) {
        const goalInstanceId = yield* workflows.goalInstanceId(params.session);
        if (goalInstanceId !== null)
          yield* (yield* HumanDecisions).close(
            DecisionCloseScope.Card({
              sessionId: params.session,
              goalInstanceId,
              cardId: body.success.cardId,
            }),
            "card_stopped",
          );
      }
      yield* (yield* AppEvents).publishSession(params.session, "run-state");
      return Match.valueTags(result, {
        Applied: (applied) => Response.json(applied),
        Requested: (requested) => Response.json(requested, { status: 202 }),
      });
    }).pipe(answerKanbanFailures),
  );
}
