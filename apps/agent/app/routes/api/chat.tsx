import { AgentChat } from "memory-agent";
import { Effect } from "effect";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/chat";

/**
 * POST /api/chat?session=<sessionId> with an AG-UI RunAgentInput body (what TanStack's
 * `fetchServerSentEvents` sends). Streams the run as Server-Sent Events.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return Response.json({ error: "session_required" }, { status: 400 });
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.handle(request, sessionId)));
}
