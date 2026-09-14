import { AgentChat } from "memory-agent";
import { Effect } from "effect";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/chat";

const sessionOf = (request: Request) => new URL(request.url).searchParams.get("session");

/**
 * GET /api/chat?session=<sessionId>&threadId=<sessionId> — what `useChat({ persistence: true })`
 * hydrates from on mount: the stored transcript, a run still generating, and pending approvals.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const sessionId = sessionOf(request);
  if (!sessionId) return Response.json({ error: "session_required" }, { status: 400 });
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.hydrate(request, sessionId)));
}

/**
 * POST /api/chat?session=<sessionId> with an AG-UI RunAgentInput body (what TanStack's
 * `fetchServerSentEvents` sends). Streams the run as Server-Sent Events.
 */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const sessionId = sessionOf(request);
  if (!sessionId) return Response.json({ error: "session_required" }, { status: 400 });
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.handle(request, sessionId)));
}
