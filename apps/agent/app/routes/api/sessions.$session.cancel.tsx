import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.cancel";

/**
 * POST /api/sessions/:session/cancel — stops the session's running run. Closing or reloading the
 * page never does; this is the only way to end a run early. Answers whether it actually stopped.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.cancel(params.session)));
}
