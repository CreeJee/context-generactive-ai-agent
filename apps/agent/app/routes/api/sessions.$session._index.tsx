import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session._index";

/**
 * GET /api/sessions/:session — run state the transcript does not carry: whether a run is still
 * producing, and how the last run ended (completed, cancelled, cut off by a server restart).
 */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.status(params.session)));
}
