import { Crypto, Effect, Match, Result, Schema } from "effect";
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

/** What the page asks of one conversation; the browser client builds the same cases. */
const ChangeSession = Schema.TaggedUnion({
  Archive: { archived: Schema.Boolean, idempotencyKey: Schema.optional(Schema.String) },
  Delete: { idempotencyKey: Schema.String },
  Phase: { phase: WorkflowPhase },
  Control: { workflowAction: WorkflowAction },
});

/**
 * GET /api/sessions/:session?holder= — run state the transcript does not carry: whether a run is
 * still producing, how the last run ended (completed, cancelled, cut off by a server restart), and
 * whether the asking page holds the session.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ request, params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const holder = new URL(request.url).searchParams.get("holder");
      return yield* Effect.flatMap(AgentChat, (chat) => chat.status(params.session, holder));
    }),
  );
}

/**
 * POST /api/sessions/:session — an `Archive` body archives the conversation or restores it, a
 * `Delete` body deletes it, `Phase` and `Control` bodies move or pause its workflow. Refused while
 * it is answering (409) or another page holds it (423).
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ChangeSession));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_session_change" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      {
        const chat = yield* AgentChat;
        const events = yield* AppEvents;
        const sessions = yield* Sessions;
        const session = yield* sessions.get(params.session);
        return yield* Match.valueTags(body.success, {
          Archive: ({ archived, idempotencyKey }) =>
            Effect.gen(function* () {
              const result = yield* chat.archive(
                params.session,
                holder,
                archived,
                idempotencyKey ?? (yield* (yield* Crypto.Crypto).randomUUIDv4()),
              );
              events.publishProject(session.projectId, "sessions");
              return result;
            }),
          Delete: ({ idempotencyKey }) =>
            Effect.gen(function* () {
              const result = yield* chat.deleteSession(params.session, holder, idempotencyKey);
              events.publishProject(session.projectId, "sessions");
              return result;
            }),
          Phase: ({ phase }) =>
            Effect.gen(function* () {
              const workflow = yield* chat.setWorkflowPhase(params.session, holder, phase);
              yield* events.publishSession(params.session, "run-state");
              return workflow;
            }),
          Control: ({ workflowAction }) =>
            Effect.gen(function* () {
              const workflow = yield* chat.controlWorkflow(params.session, holder, workflowAction);
              yield* events.publishSession(params.session, "run-state");
              return workflow;
            }),
        });
      }
    }),
  );
}
