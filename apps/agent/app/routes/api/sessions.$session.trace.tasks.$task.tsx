import { Effect, Result, Schema } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.trace.tasks.$task";

const TaskAction = Schema.Union([
  Schema.Struct({
    intent: Schema.Literal("resume"),
    expectedAttemptId: Schema.String,
    confirmUncertain: Schema.Boolean.pipe(
      Schema.withDecodingDefaultTypeKey(Effect.sync(() => false)),
    ),
  }),
  Schema.Struct({
    intent: Schema.Literals(["archive", "restore", "delete"]),
    idempotencyKey: Schema.optional(Schema.String),
  }),
]);

/** GET /api/sessions/:session/trace/tasks/:task — task attempt and checkpoint detail. */
export async function loader({ params }: Route.LoaderArgs) {
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) => chat.traceTask(params.session, params.task)),
  );
}

/** POST queues a safe logical resume for execution under the next valid parent run binding. */
export async function action({ request, params }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, TaskAction);
  if (Result.isFailure(body))
    return Response.json({ error: "invalid_trace_task_action" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      body.success.intent === "resume"
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
            body.success.idempotencyKey ?? crypto.randomUUID(),
          ),
    ),
  );
}
