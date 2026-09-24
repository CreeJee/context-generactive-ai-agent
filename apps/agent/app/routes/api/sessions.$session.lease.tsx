import { Effect, Result, Schema } from "effect";
import { AgentChat, AppEvents } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.lease";

const LeaseRequest = Schema.Struct({
  holder: Schema.NonEmptyString,
  action: Schema.Literals(["claim", "release"]),
});

/** A lease is changed through POST only. Return a clear response for accidental GETs. */
export function loader() {
  return Response.json(
    { error: "method_not_allowed", method: "POST" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/**
 * POST /api/sessions/:session/lease { holder, action } — a page claims (or renews) the right to
 * change the session, or gives it up (also sent as a beacon when the page closes). Answers who
 * holds the session from that page's point of view.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, LeaseRequest);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_lease_request" }, { status: 400 });
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.lease(params.session, body.success.holder, body.success.action),
    ).pipe(
      Effect.tap(() =>
        Effect.map(AppEvents, (events) => events.publishSession(params.session, "run-state")),
      ),
    ),
  );
}
