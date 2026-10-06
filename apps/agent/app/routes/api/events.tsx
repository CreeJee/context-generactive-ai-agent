import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/events";

/** GET /api/events — all app query invalidations on one connection. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// @effect-diagnostics-next-line asyncFunction:off
export async function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(Effect.map(AppEvents, (events) => events.allStream(request)));
}
