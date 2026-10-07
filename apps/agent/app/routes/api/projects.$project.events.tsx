import { Effect } from "effect";
import { AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/projects.$project.events";

/** GET /api/projects/:project/events — ephemeral project query invalidations. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export async function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.map(AppEvents, (events) => events.projectStream(request, params.project)),
  );
}
