import { Effect, Either, Schema } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.approvals.$approval";

const Answer = Schema.Struct({ approved: Schema.Boolean });

/**
 * POST /api/sessions/:session/approvals/:approval { approved } — answers a call a subagent or an
 * external agent is waiting on. Only the page holding the session may answer.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, Answer);
  if (Either.isLeft(body)) return Response.json({ error: "invalid_answer" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      chat.answerApproval(params.session, holder, params.approval, body.right.approved),
    ),
  );
}
