import { Effect, Either, Schema } from "effect";
import { AgentChat, WorkflowAction, WorkflowPhase, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session._index";

const ChangeSession = Schema.Union(
  Schema.Struct({ archived: Schema.Boolean }),
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
    Effect.flatMap(AgentChat, (chat) => {
      const change = body.right;
      if ("archived" in change) return chat.archive(params.session, holder, change.archived);
      if ("phase" in change) return chat.setWorkflowPhase(params.session, holder, change.phase);
      return chat.controlWorkflow(params.session, holder, change.workflowAction);
    }),
  );
}
