import { Effect } from "effect";
import { Boards, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/projects.$project.boards";

/**
 * GET /api/projects/:project/boards — every unarchived conversation's Plan as a board, with its
 * column counts; running boards first, then the most recently changed.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* Boards).list(params.project));
    }).pipe(answerKanbanFailures),
  );
}
