import { Effect } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.cancel";

/**
 * POST /api/sessions/:session/cancel — stops the session's running run. Closing or reloading the
 * page never does; this is the only way to end a run early. Answers whether it actually stopped.
 * Only the page holding the session may cancel.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.cancel(params.session, holder)));
}
