import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/events";

/** GET /api/events — ephemeral global query invalidations. */
export async function loader({ request }: Route.LoaderArgs) {
  return agent.runPromise(Effect.map(AppEvents, (events) => events.globalStream(request)));
}
