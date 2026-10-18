import { Effect, Option, Result, Schema } from "effect";
import {
  AppEvents,
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

const KanbanAction = Schema.Union([
  Schema.TaggedStruct("Start", {}),
  Schema.TaggedStruct("SetPriority", { priority: GoalPriority }),
  Schema.TaggedStruct("SetDependencies", { dependsOn: Schema.Array(Schema.String) }),
  BoardIntent,
]);

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
 * POST /api/sessions/:session/kanban { _tag: "Start" } runs the executing Plan as a kanban board.
 * A `BoardIntent` (Reorder, Requeue, Hold, Release, ChangeRequest, Cancel) is what a person meant
 * by dragging a card; the owner decides the card's status and refuses (409) an intent the card's
 * state does not fit. A change request to an executing card is stored (202).
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
      switch (body.success._tag) {
        case "Start": {
          const started = yield* (yield* KanbanOrchestrator).start(params.session);
          yield* events.publishSession(params.session, "run-state");
          return Response.json(started);
        }
        case "Reorder":
        case "Requeue":
        case "Hold":
        case "Release":
        case "ChangeRequest":
        case "Cancel": {
          const result = yield* (yield* KanbanBoardActions).applyIntent(
            params.session,
            body.success,
            { _tag: "User" },
          );
          yield* events.publishSession(params.session, "run-state");
          switch (result._tag) {
            case "Applied":
              return Response.json(result);
            case "Requested":
              return Response.json(result, { status: 202 });
          }
        }
        case "SetPriority": {
          yield* (yield* KanbanBoardActions).setPriority(params.session, body.success.priority);
          yield* events.publishSession(params.session, "run-state");
          return Response.json({ priority: body.success.priority });
        }
        case "SetDependencies": {
          const dependsOn = yield* (yield* KanbanBoardActions).setDependencies(
            params.session,
            body.success.dependsOn,
          );
          yield* events.publishSession(params.session, "run-state");
          return Response.json({ dependsOn });
        }
      }
    }).pipe(answerKanbanFailures),
  );
}
