import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.subagents._index";

/** GET /api/sessions/:session/subagents — the session's subagents and calls waiting for approval. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.subagents(params.session)));
}
