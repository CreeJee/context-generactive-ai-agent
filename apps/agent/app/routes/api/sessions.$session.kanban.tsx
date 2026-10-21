import { Effect, Match, Option, Result, Schema } from "effect";
import {
  AppEvents,
  BoardAuthor,
  BoardIntent,
  GoalPriority,
  KanbanBoardActions,
  KanbanOrchestrator,
  SessionLeases,
  Sessions,
  sessionHolderHeader,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/sessions.$session.kanban";

/** The board's own commands; a `BoardIntent` is what a person meant by dragging a card. */
const KanbanCommand = Schema.TaggedUnion({
  Start: {},
  RestartLoop: {},
  SetPriority: { priority: GoalPriority },
  SetDependencies: { dependsOn: Schema.Array(Schema.String) },
});
const KanbanAction = Schema.Union([KanbanCommand, BoardIntent]);

/** GET /api/sessions/:session/kanban — whether the Goal runs as a board, and why cards stopped. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Sessions).get(params.session);
      const view = yield* (yield* KanbanBoardActions).view(params.session);
      return Response.json(
        Option.match(view, {
          onNone: () => ({ active: false as const }),
          onSome: (board) => ({ active: true as const, ...board }),
        }),
      );
    }).pipe(answerKanbanFailures),
  );
}

/**
 * POST /api/sessions/:session/kanban { _tag: "Start" } runs the executing Plan as a kanban board;
 * { _tag: "RestartLoop" } runs a board's loop again after it stopped.
 * A `BoardIntent` (Reorder, Requeue, Hold, Release, ChangeRequest, Cancel, Transfer) is what a
 * person meant by dragging a card; the owner decides the card's status and refuses (409) an intent
 * the card's state does not fit. A change request to an executing card is stored (202).
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, KanbanAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_kanban_action" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      if (!(yield* SessionLeases).permits(params.session, holder))
        return Response.json({ error: "session_in_use" }, { status: 423 });
      yield* (yield* Sessions).get(params.session);
      const events = yield* AppEvents;
      const actions = yield* KanbanBoardActions;
      const applyIntent = (intent: BoardIntent) =>
        Effect.gen(function* () {
          const result = yield* actions.applyIntent(
            params.session,
            intent,
            BoardAuthor.cases.User.make({}),
          );
          yield* events.publishSession(params.session, "run-state");
          return Match.valueTags(result, {
            Applied: (applied) => Response.json(applied),
            Requested: (requested) => Response.json(requested, { status: 202 }),
          });
        });
      return yield* Match.valueTags(body.success, {
        Start: () =>
          Effect.gen(function* () {
            const started = yield* (yield* KanbanOrchestrator).start(params.session);
            yield* events.publishSession(params.session, "run-state");
            return Response.json(started);
          }),
        RestartLoop: () =>
          actions
            .restartLoop(params.session)
            .pipe(Effect.map(() => Response.json({ restarted: true }))),
        Reorder: applyIntent,
        Requeue: applyIntent,
        Hold: applyIntent,
        Release: applyIntent,
        ChangeRequest: applyIntent,
        Cancel: applyIntent,
        // The card lands on another conversation's board, so that board is told too.
        Transfer: (intent) =>
          applyIntent(intent).pipe(
            Effect.tap(() => events.publishSession(intent.toSessionId, "run-state")),
          ),
        SetPriority: ({ priority }) =>
          Effect.gen(function* () {
            yield* actions.setPriority(params.session, priority);
            yield* events.publishSession(params.session, "run-state");
            return Response.json({ priority });
          }),
        SetDependencies: (command) =>
          Effect.gen(function* () {
            const dependsOn = yield* actions.setDependencies(params.session, command.dependsOn);
            yield* events.publishSession(params.session, "run-state");
            return Response.json({ dependsOn });
          }),
      });
    }).pipe(answerKanbanFailures),
  );
}
