import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.approvals._index";

/**
 * GET /api/sessions/:session/approvals — calls waiting for the user that could not pause the run:
 * a subagent's, or an external agent's own permission requests.
 */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.approvals(params.session)));
}
