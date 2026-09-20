import { Effect, Either, Schema } from "effect";
import { AgentChat, sessionHolderHeader } from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/sessions.$session.trace.tasks.$task";

const TaskAction = Schema.Union(
  Schema.Struct({
    intent: Schema.Literal("resume"),
    expectedAttemptId: Schema.String,
    confirmUncertain: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  }),
  Schema.Struct({
    intent: Schema.Literal("archive", "restore", "delete"),
    idempotencyKey: Schema.optional(Schema.String),
  }),
);

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
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_trace_task_action" }, { status: 400 });
  const holder = request.headers.get(sessionHolderHeader);
  return agent.runPromise(
    Effect.flatMap(AgentChat, (chat) =>
      body.right.intent === "resume"
        ? chat.requestTraceResume(
            params.session,
            holder,
            params.task,
            body.right.expectedAttemptId,
            body.right.confirmUncertain,
          )
        : chat.lifecycleTraceTask(
            params.session,
            holder,
            params.task,
            body.right.intent,
            body.right.idempotencyKey ?? crypto.randomUUID(),
          ),
    ),
  );
}
