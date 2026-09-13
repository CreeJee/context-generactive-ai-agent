import { Effect } from "effect";
import { Nodes, Sessions, sessionMessages } from "memory-agent";
import { agent } from "~/.server/agent";
import type { Route } from "./+types/sessions.$session.messages";

/** GET /api/sessions/:session/messages — the stored transcript as useChat UIMessages. */
export async function loader({ params }: Route.LoaderArgs) {
  const response = Effect.gen(function* () {
    yield* (yield* Sessions).get(params.session);
    const nodes = yield* Nodes;
    return Response.json(sessionMessages(nodes.session(params.session)));
  }).pipe(
    Effect.catchTag("SessionNotFound", () =>
      Effect.succeed(Response.json({ error: "session_not_found" }, { status: 404 })),
    ),
  );
  return agent.runPromise(response);
}
