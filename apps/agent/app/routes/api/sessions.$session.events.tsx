import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.events";

/** GET /api/sessions/:session/events — ephemeral session query invalidations. */
export async function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.map(AppEvents, (events) => events.sessionStream(request, params.session)),
  );
}
