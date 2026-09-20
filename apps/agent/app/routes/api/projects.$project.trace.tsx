import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/projects.$project.trace";

/** GET /api/projects/:project/trace — project-owned tasks, including deleted origins. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.projectTraceTree(params.project)),
  );
}
