import { Effect, Result, Schema } from "effect";
import { AgentChat, AppEvents, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.queue.$message";

const QueueEdit = Schema.Union([
  Schema.Struct({ action: Schema.Literal("edit"), draft: Schema.String }),
  Schema.Struct({ action: Schema.Literal("save"), text: Schema.String }),
  Schema.Struct({ action: Schema.Literal("remove") }),
  Schema.Struct({ action: Schema.Literal("confirm") }),
]);

/**
 * POST /api/sessions/:session/queue/:message { action } — edit (store unsaved text), save, remove,
 * or confirm a held message. Only the page holding the session may change the queue.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, QueueEdit);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_queue_edit" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.editQueued(params.session, holder, params.message, body.success),
    ).pipe(
      Effect.tap(() =>
        Effect.map(AppEvents, (events) => events.publishSession(params.session, "queue")),
      ),
    ),
  );
}
