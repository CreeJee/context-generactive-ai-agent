import { Effect, Either, Schema } from "effect";
import {
  AgentChat,
  AppEvents,
  Sessions,
  WorkflowAction,
  WorkflowPhase,
  sessionHolderHeader,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session._index";

const ChangeSession = Schema.Union(
  Schema.Struct({ archived: Schema.Boolean, idempotencyKey: Schema.optional(Schema.String) }),
  Schema.Struct({ delete: Schema.Literal(true), idempotencyKey: Schema.String }),
  Schema.Struct({ phase: WorkflowPhase }),
  Schema.Struct({ workflowAction: WorkflowAction }),
);

/**
 * GET /api/sessions/:session?holder= — run state the transcript does not carry: whether a run is
 * still producing, how the last run ended (completed, cancelled, cut off by a server restart), and
 * whether the asking page holds the session.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const holder = new URL(request.url).searchParams.get("holder");
  return agent.runPromise(Effect.flatMap(AgentChat, (chat) => chat.status(params.session, holder)));
}

/**
 * POST /api/sessions/:session { archived } — archives the conversation or restores it. Refused
 * while it is answering (409) or another page holds it (423).
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ChangeSession);
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_session_change" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.gen(function* () {
      const chat = yield* AgentChat;
      const events = yield* AppEvents;
      const sessions = yield* Sessions;
      const session = yield* sessions.get(params.session);
      const change = body.right;
      if ("archived" in change) {
        const result = yield* chat.archive(
          params.session,
          holder,
          change.archived,
          change.idempotencyKey ?? crypto.randomUUID(),
        );
        events.publishProject(session.projectId, "sessions");
        return result;
      }
      if ("delete" in change) {
        const result = yield* chat.deleteSession(params.session, holder, change.idempotencyKey);
        events.publishProject(session.projectId, "sessions");
        return result;
      }
      const workflow =
        "phase" in change
          ? yield* chat.setWorkflowPhase(params.session, holder, change.phase)
          : yield* chat.controlWorkflow(params.session, holder, change.workflowAction);
      events.publishSession(params.session, "run-state");
      return workflow;
    }),
  );
}
