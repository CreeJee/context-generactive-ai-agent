import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.subagents.$subagent";

/** GET /api/sessions/:session/subagents/:subagent — one subagent's saved conversation. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.subagentTranscript(params.session, params.subagent)),
  );
}
