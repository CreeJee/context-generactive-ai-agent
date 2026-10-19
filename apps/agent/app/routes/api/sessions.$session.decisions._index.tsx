import { Effect } from "effect";
import { HumanDecisions, Sessions } from "memory-agent";
import { agent } from "~/.server/agent";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/sessions.$session.decisions._index";

/** GET /api/sessions/:session/decisions — the board's cards waiting for a person's decision. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Sessions).get(params.session);
      return Response.json(yield* (yield* HumanDecisions).pending(params.session));
    }).pipe(answerKanbanFailures),
  );
}
