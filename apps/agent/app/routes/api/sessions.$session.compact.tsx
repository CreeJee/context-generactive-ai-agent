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
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const holder = request.headers.get(sessionHolderHeader);
      return yield* Effect.flatMap(AgentChat, (chat) => chat.compact(params.session, holder));
    }),
  );
}
