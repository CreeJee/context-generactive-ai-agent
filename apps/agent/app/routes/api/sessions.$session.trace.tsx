import { Effect } from "effect";
import { AgentChat } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.trace";

/** GET /api/sessions/:session/trace — persisted task tree and current cursor. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.traceTree(params.session)));
}
