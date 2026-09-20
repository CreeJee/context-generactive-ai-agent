import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/projects.$project.trace.tasks.$task";

/** GET /api/projects/:project/trace/tasks/:task — project-owned immutable task detail. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.projectTraceTask(params.project, params.task)),
  );
}
