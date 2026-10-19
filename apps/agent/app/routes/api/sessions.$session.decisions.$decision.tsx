import { Effect, Result, Schema } from "effect";
import {
  DecisionAnswer,
  HumanDecisions,
  KanbanOrchestrator,
  SessionLeases,
  sessionHolderHeader,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import { answerKanbanFailures } from "~/.server/kanban-failures";
import type { Route } from "./+types/sessions.$session.decisions.$decision";

const Answer = Schema.Struct({
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  answer: DecisionAnswer,
});

/**
 * POST /api/sessions/:session/decisions/:decision { goalInstanceId, cardId, answer } — a person
 * answers a card's decision, from its board or from the project inbox. The same answer again is
 * accepted; a different one (409), a closed request (409) or one of another session, Goal or card
 * (404) is refused, as is a session another page holds (423).
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, Answer));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_decision_answer" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      if (!(yield* SessionLeases).permits(params.session, holder))
        return Response.json({ error: "session_in_use" }, { status: 423 });
      const answered = yield* (yield* HumanDecisions).answer({
        ...body.success,
        sessionId: params.session,
        requestId: params.decision,
      });
      // The answer moved the card; the board's loop takes it up now instead of at its next look.
      yield* (yield* KanbanOrchestrator).poke(answered.goalInstanceId);
      return Response.json(answered);
    }).pipe(answerKanbanFailures),
  );
}
