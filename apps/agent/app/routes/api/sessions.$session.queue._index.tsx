import { Effect, Either } from "effect";
import { AgentChat, QueueRequest, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.queue._index";

/** GET /api/sessions/:session/queue — messages waiting to reach the agent, and those just delivered. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.queued(params.session)));
}

/**
 * POST /api/sessions/:session/queue { text, attachmentIds, mode } — a message written while a run
 * answers: `queue` for the next tool-call boundary, `steer` into the answering turn now. 409
 * `not_running` means nothing is answering and the page should send a normal turn.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, QueueRequest);
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_queue_request" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.enqueue(params.session, holder, body.right)),
  );
}
