import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/projects.$project.trace.tasks.$task";

/** GET /api/projects/:project/trace/tasks/:task — project-owned immutable task detail. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.projectTraceTask(params.project, params.task)),
  );
}
