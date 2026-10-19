import { Effect } from "effect";
import { HumanDecisions, Projects } from "memory-agent";
import { agent } from "~/.server/agent";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/projects.$project.decisions";

/**
 * GET /api/projects/:project/decisions — the project inbox: every unanswered card decision across
 * its conversations and their current Goals, oldest first.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      yield* (yield* Projects).get(params.project);
      return Response.json(yield* (yield* HumanDecisions).inbox(params.project));
    }).pipe(answerKanbanFailures),
  );
}
