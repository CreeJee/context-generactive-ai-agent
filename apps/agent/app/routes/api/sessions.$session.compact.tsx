import { Effect } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.compact";

/**
 * POST /api/sessions/:session/compact — `/compact`: the model is no longer sent the tool output it
 * has already answered from; each cleared output keeps a pointer to its memory node. 409
 * `run_in_progress` while the session is answering. Only the page holding the session may do it.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.compact(params.session, holder)),
  );
}
