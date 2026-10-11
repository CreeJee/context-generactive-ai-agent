import { Crypto, Effect, Result, Schema } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.trace.tasks.$task";

const TaskAction = Schema.Union([
  Schema.Struct({
    intent: Schema.Literal("resume"),
    expectedAttemptId: Schema.String,
    confirmUncertain: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  }),
  Schema.Struct({
    intent: Schema.Literals(["archive", "restore", "delete"]),
    idempotencyKey: Schema.optional(Schema.String),
  }),
]);

/** GET /api/sessions/:session/trace/tasks/:task — task attempt and checkpoint detail. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.traceTask(params.session, params.task)),
  );
}

/** POST queues a safe logical resume for execution under the next valid parent run binding. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request, params }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, TaskAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_trace_task_action" }, { status: 400 });
      const holder = request.headers.get(sessionHolderHeader);
      const chat = yield* AgentChat;
      return yield* body.success.intent === "resume"
        ? chat.requestTraceResume(
            params.session,
            holder,
            params.task,
            body.success.expectedAttemptId,
            body.success.confirmUncertain,
          )
        : chat.lifecycleTraceTask(
            params.session,
            holder,
            params.task,
            body.success.intent,
            // Browser/native SDK boundary requires a cryptographic correlation or idempotency token.
            body.success.idempotencyKey ?? (yield* (yield* Crypto.Crypto).randomUUIDv4()),
          );
    }),
  );
}
