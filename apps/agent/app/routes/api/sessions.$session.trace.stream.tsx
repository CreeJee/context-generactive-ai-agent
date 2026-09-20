import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.trace.stream";

/** GET /api/sessions/:session/trace/stream — snapshot plus durable cursor SSE tail. */
export async function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.traceStream(request, params.session)),
  );
}
