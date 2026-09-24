import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/events";

/** GET /api/events — all app query invalidations on one connection. */
export async function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(Effect.map(AppEvents, (events) => events.allStream(request)));
}
