import { Effect, Result } from "effect";
import { AgentChat, UncertainContinueRequest, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.uncertain";

/**
 * POST /api/sessions/:session/uncertain `{ runIds }` — the user saw the Goal runs whose tools left
 * their outcome unknown and continues without replaying them.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, UncertainContinueRequest));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_uncertain_continue" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      return yield* Effect.flatMap(AgentChat, (chat) =>
        chat.continuePastUncertain(params.session, holder, body.success),
      );
    }),
  );
}
