import { Effect, Result } from "effect";
import { AgentChat, AppEvents, QueueRequest, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.queue._index";

/** GET /api/sessions/:session/queue — messages waiting to reach the agent, and those just delivered. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.queued(params.session)));
}

/**
 * POST /api/sessions/:session/queue { text, attachmentIds, mode } — a message written while a run
 * answers: `queue` goes at the next tool-call boundary, or as the next turn the page sends; `steer`
 * also cuts the answer being written and the server sends it next. 409
 * `not_running` means nothing is answering and the page should send a normal turn.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, QueueRequest));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_queue_request" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      return yield* Effect.flatMap(AgentChat, (chat) =>
        chat.enqueue(params.session, holder, body.success),
      ).pipe(
        Effect.tap(() =>
          Effect.map(AppEvents, (events) => events.publishSession(params.session, "queue")),
        ),
      );
    }),
  );
}
