import { Effect } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.interrupts.discard";

/** POST /api/sessions/:session/interrupts/discard — abandons an unusable approval continuation. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected !== null) return rejected;
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.discardInterrupts(params.session, holder)),
  );
}
