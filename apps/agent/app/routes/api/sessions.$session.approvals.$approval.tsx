import { Effect, Result, Schema } from "effect";
import { AgentChat, AppEvents, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.approvals.$approval";

const Answer = Schema.Struct({ approved: Schema.Boolean });

/**
 * POST /api/sessions/:session/approvals/:approval { approved } — answers a call a subagent or an
 * external agent is waiting on. Only the page holding the session may answer.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, Answer));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_answer" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      return yield* Effect.flatMap(AgentChat, (chat) =>
        chat.answerApproval(params.session, holder, params.approval, body.success.approved),
      ).pipe(
        Effect.tap(() =>
          Effect.flatMap(AppEvents, (events) =>
            events.publishSession(params.session, "relayed-approvals"),
          ),
        ),
      );
    }),
  );
}
