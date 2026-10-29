import { Effect } from "effect";
import { agent } from "~/.server/agent";
import { pickFolder } from "~/.server/folder-picker";
import { rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/projects.pick";

/**
 * POST /api/projects/pick — opens the host's folder dialog and answers the chosen folder
 * (`picked`), `cancelled`, or `unavailable` when this host has no dialog. Nothing is registered
 * here; the page adds the answer through POST /api/projects.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      return Response.json(yield* pickFolder());
    }),
  );
}
