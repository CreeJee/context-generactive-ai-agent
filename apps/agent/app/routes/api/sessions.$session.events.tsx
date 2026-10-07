import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.events";

/** GET /api/sessions/:session/events — ephemeral session query invalidations. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.map(AppEvents, (events) => events.sessionStream(request, params.session)),
  );
}
