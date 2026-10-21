import { isTruthy } from "../truthy.ts";
import { randomUUID } from "../runtime/synchronous-crypto.ts";
import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import {
  MutableHashMap,
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import { ChatState } from "../chat-state/chat-state.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { AttemptFailureReason } from "../work-trace/contracts.ts";
import { WorkTraceStore } from "../work-trace/store.ts";
import { toToolSchema } from "./schema.ts";
import { failureTags } from "../runtime/logged-failures.ts";
import { onRun, runTrace } from "../runtime/run-trace.ts";
import { SqlClient, SqlSchema } from "effect/sql";

export interface BackgroundBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly abortSignal: AbortSignal;
}

export class BackgroundOperationFailed extends Schema.TaggedError<BackgroundOperationFailed>()(
  "BackgroundOperationFailed",
  { cause: Schema.Defect() },
) {}

export class BackgroundResultStoreFailed extends Schema.TaggedError<BackgroundResultStoreFailed>()(
  "BackgroundResultStoreFailed",
  { operation: Schema.Literals(["read", "write", "decode"]), cause: Schema.Defect() },
) {}

export class BackgroundTraceFailed extends Schema.TaggedError<BackgroundTraceFailed>()(
  "BackgroundTraceFailed",
  { cause: Schema.Defect() },
) {}

/** The model reads `message`; it is fixed and names no task data. */
export class BackgroundTaskNotFound extends Schema.TaggedError<BackgroundTaskNotFound>()(
  "BackgroundTaskNotFound",
  { message: Schema.String },
) {}

/** Promise SDK boundary: cancellation aborts the source and awaits its settled Exit. */
export const backgroundOperation = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A, BackgroundOperationFailed>((resume, signal) => {
    const settled = Promise.resolve()
      .then(() => operation(signal))
      .then(
        (value) => Exit.succeed(value),
        (cause) => Exit.fail(BackgroundOperationFailed.make({ cause })),
      );
    void settled.then((exit) => resume(exit));
    // `settled` maps both outcomes to an Exit, so it never rejects.
    return Effect.asVoid(Effect.promise(() => settled));
  });

const parentInterrupted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const interrupt = () => resume(Effect.interrupt);
    if (signal.aborted) interrupt();
    else signal.addEventListener("abort", interrupt, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", interrupt));
  });

/**
 * What a background operation returns: its report, and why it ended abnormally when it did. A
 * command that exited non-zero still reports its output; its attempt is recorded as failed.
 */
export interface BackgroundOutcome {
  readonly report: string;
  readonly failure: AttemptFailureReason | null;
}

const ResultInput = Schema.Struct({
  taskId: Schema.NonEmptyString,
  offset: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
const SavedResult = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  result: Schema.String,
});
const namespace = "background-task-result";

const make = Effect.gen(function* () {
  const trace = yield* WorkTraceStore;
  const sql = yield* SqlClient.SqlClient;
  const priorDispatch = SqlSchema.findOneOption({
    Request: Schema.Struct({
      idempotencyKey: Schema.String,
      sessionId: Schema.String,
      agentName: Schema.String,
    }),
    Result: Schema.Struct({
      taskId: Schema.String,
      attemptId: Schema.String,
      status: Schema.String,
    }),
    execute: (request) => sql`
      SELECT t.id AS taskId, a.id AS attemptId, a.status
      FROM agent_invocations i JOIN work_tasks t ON t.id = i.task_id
      JOIN agent_run_attempts a ON a.invocation_id = i.id
      WHERE i.idempotency_key = ${request.idempotencyKey}
        AND t.origin_session_id = ${request.sessionId} AND t.agent_name = ${request.agentName}`,
  });
  const state = yield* ChatState;
  const redactor = yield* SecretRedactor;
  const context = yield* Effect.context<never>();
  const fibers = yield* FiberMap.make<string>();
  const dispatch = Semaphore.makeUnsafe(1);
  const sessions = MutableHashMap.empty<string, string>();
  let onCompletion: ((sessionId: string) => void) | undefined;
  const loadResult = Effect.fn("BackgroundTasks.loadResult")(function* (taskId: string) {
    const saved = yield* Effect.tryPromise({
      try: () => state.persistence.stores.metadata.get(namespace, taskId),
      catch: (cause) => BackgroundResultStoreFailed.make({ operation: "read", cause }),
    });
    return saved === null
      ? null
      : yield* Schema.decodeUnknownEffect(SavedResult)(saved).pipe(
          Effect.mapError((cause) =>
            BackgroundResultStoreFailed.make({ operation: "decode", cause }),
          ),
        );
  });
  const traceEffect = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, (cause) => BackgroundTraceFailed.make({ cause }));

  const owned = Effect.fn("BackgroundTasks.owned")(function* (sessionId: string, taskId: string) {
    const detail = yield* traceEffect(trace.taskDetail(sessionId, taskId));
    if (
      !isTruthy(detail) ||
      !detail.task.agentName.startsWith("background_") ||
      detail.task.deletedAt !== null ||
      detail.task.deleteRequestedAt !== null
    )
      return yield* BackgroundTaskNotFound.make({
        message: "Background task not found in this session",
      });
    return detail;
  });

  const readResult = Effect.fn("BackgroundTasks.readResult")(function* (
    sessionId: string,
    taskId: string,
  ) {
    const detail = yield* owned(sessionId, taskId);
    const saved = yield* loadResult(taskId);
    if (saved !== null) return saved;
    if (detail.attempts.at(-1)?.status === "failed")
      return {
        status: "failed" as const,
        result:
          "Result unavailable: background_result_storage_failed. Inspect recorded effects before retrying.",
      };
    return null;
  });

  const start = Effect.fn("BackgroundTasks.start")(function* (
    binding: BackgroundBinding,
    toolCallId: string,
    kind: "shell" | "external_agent",
    request: string,
    operation: Effect.Effect<BackgroundOutcome, BackgroundOperationFailed>,
  ) {
    if (binding.abortSignal.aborted) return yield* Effect.interrupt;
    const hiddenRequest = yield* redactor.redactText(request);
    return yield* dispatch.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (binding.abortSignal.aborted) return yield* Effect.interrupt;
          const prior = yield* priorDispatch({
            idempotencyKey: `${binding.runId}:${toolCallId}`,
            sessionId: binding.sessionId,
            agentName: `background_${kind}`,
          });
          if (Option.isSome(prior)) {
            return {
              ...prior.value,
              nextAction:
                "This operation was already dispatched. Retrieve its result; do not resend it.",
            };
          }
          const handle = yield* traceEffect(
            trace.startAttempt({
              sessionId: binding.sessionId,
              parentRunId: binding.runId,
              parentToolCallId: toolCallId,
              agentId: null,
              agentName: `background_${kind}`,
              title: hiddenRequest.text.replace(/\s+/gu, " ").slice(0, 80),
              request: hiddenRequest.text,
              kind: "start",
              threadId: `background-${randomUUID()}`,
            }),
          );
          MutableHashMap.set(sessions, handle.taskId, binding.sessionId);
          const save = Effect.fn("BackgroundTasks.saveResult")(function* (
            status: typeof SavedResult.Type.status,
            result: string,
          ) {
            const hidden = yield* redactor.redactText(result);
            yield* Effect.tryPromise({
              try: () =>
                state.persistence.stores.metadata.set(namespace, handle.taskId, {
                  status,
                  result: hidden.text,
                }),
              catch: (cause) => BackgroundResultStoreFailed.make({ operation: "write", cause }),
            });
          });
          const finalize = Effect.fn("BackgroundTasks.finalize")(function* (
            exit: Exit.Exit<BackgroundOutcome, BackgroundOperationFailed | BackgroundTraceFailed>,
          ) {
            // `saved` is what get_background_result returns; `failure` is why the attempt failed.
            const { saved, failure } = Exit.match(exit, {
              onSuccess: ({ report, failure }) => ({
                saved: { status: "completed" as const, result: report },
                failure,
              }),
              onFailure: (cause) =>
                Cause.hasInterrupts(cause)
                  ? {
                      saved: {
                        status: "cancelled" as const,
                        result: "Operation stopped. Inspect its effects before retrying.",
                      },
                      failure: null,
                    }
                  : // Tags only: the cause can hold command output, paths or provider text.
                    {
                      saved: {
                        status: "failed" as const,
                        result: `Operation failed (${failureTags(cause)}). Inspect its effects before retrying.`,
                      },
                      failure: AttemptFailureReason.cases.OperationFailed.make({}),
                    },
            });
            // Persist once. A storage failure is not a second operation failure to save again.
            const stored = yield* Effect.exit(save(saved.status, saved.result));
            const recorded = Exit.isSuccess(stored)
              ? { failure, stage: "process" as const }
              : {
                  failure: AttemptFailureReason.cases.ResultStorageFailed.make({}),
                  stage: "finish" as const,
                };
            const status =
              recorded.failure !== null
                ? "failed"
                : saved.status === "cancelled"
                  ? "cancelled"
                  : "completed";
            yield* traceEffect(
              trace.transitionAttempt(
                handle,
                binding.sessionId,
                status,
                status === "completed"
                  ? "attempt_completed"
                  : status === "cancelled"
                    ? "attempt_cancelled"
                    : "attempt_failed",
                Exit.isSuccess(stored)
                  ? `Background ${kind} ${status}; retrieve with get_background_result taskId ${handle.taskId}`
                  : `Background ${kind} ended but result storage failed; inspect effects before retrying`,
                recorded.failure === null
                  ? null
                  : { reason: recorded.failure, stage: recorded.stage },
                false,
                binding.runId,
              ),
            );
            yield* Effect.sync(() => onCompletion?.(binding.sessionId));
          });
          const job = Effect.gen(function* () {
            yield* traceEffect(
              trace.transitionAttempt(
                handle,
                binding.sessionId,
                "running",
                "attempt_started",
                `Background ${kind} started`,
              ),
            );
            return yield* Effect.raceFirst(operation, parentInterrupted(binding.abortSignal));
          }).pipe(
            Effect.onExit((exit) =>
              finalize(exit).pipe(
                Effect.catch((error) =>
                  Effect.logError("Background terminal recording failed", {
                    taskId: handle.taskId,
                    error: failureTags(Cause.fail(error)),
                  }),
                ),
              ),
            ),
            Effect.exit,
            Effect.asVoid,
            Effect.ensuring(
              Effect.sync(() => {
                MutableHashMap.remove(sessions, handle.taskId);
              }),
            ),
          );
          // The attempt beats while the operation runs; a lost fiber stops the beats.
          yield* FiberMap.run(
            fibers,
            handle.taskId,
            Effect.interruptible(
              Effect.forkScoped(trace.keepAlive(handle)).pipe(Effect.andThen(job), Effect.scoped),
            ),
          );
          return {
            status: "running" as const,
            taskId: handle.taskId,
            attemptId: handle.id,
            nextAction:
              "Continue independent work. Retrieve the result with get_background_result after completion.",
          };
        }),
      ),
    );
  });

  return {
    start,
    waitResult: Effect.fn("BackgroundTasks.waitResult")(function* (
      sessionId: string,
      taskId: string,
      milliseconds: number,
    ) {
      const waiting = Effect.gen(function* () {
        while (true) {
          const cursor = yield* traceEffect(trace.latestCursor(sessionId));
          const result = yield* readResult(sessionId, taskId);
          if (result !== null) return result;
          yield* Effect.tryPromise({
            try: (signal) => trace.waitForChange(sessionId, cursor, signal),
            catch: (cause) => BackgroundOperationFailed.make({ cause }),
          });
        }
      });
      if (milliseconds === 0) return yield* readResult(sessionId, taskId);
      const result = Option.getOrNull(yield* waiting.pipe(Effect.timeoutOption(milliseconds)));
      const now = yield* Clock.currentTimeMillis;
      if (result !== null)
        yield* sql`
          UPDATE parent_notifications
          SET delivered_to_run_id = (SELECT parent_run_id FROM work_tasks WHERE id = ${taskId}),
            delivered_at = ${now}
          WHERE task_id = ${taskId} AND delivered_at IS NULL`;
      return result;
    }),
    onCompletion(listener: (sessionId: string) => void) {
      onCompletion = listener;
    },
    hasSession(sessionId: string) {
      return [...MutableHashMap.values(sessions)].includes(sessionId);
    },
    stopTask(taskId: string) {
      return FiberMap.remove(fibers, taskId);
    },
    stopSession: Effect.fn("BackgroundTasks.stopSession")(function* (sessionId: string) {
      yield* Effect.forEach(
        [...sessions].filter(([, id]) => id === sessionId),
        ([taskId]) => FiberMap.remove(fibers, taskId),
        { concurrency: "unbounded", discard: true },
      );
    }),
    /** The tools run on the run's context, so their spans join the run's trace. */
    forSession: (sessionId: string) =>
      Effect.map(runTrace, (caller): AnyServerTool[] => {
        const run = Effect.runPromiseWith(onRun(context, caller));
        return [
          toolDefinition({
            name: "get_background_result",
            description:
              "Retrieve one background shell or ACP task's saved, redacted result by taskId. Result is JSON text, paged in 4000-character chunks with nextOffset; read all required pages before relying on it. Returns running if unfinished; interrupted after restart means do not retry blindly. A notification alone is not a result.",
            inputSchema: toToolSchema(ResultInput),
          }).server(({ taskId, offset = 0 }) =>
            run(
              Effect.gen(function* () {
                const detail = yield* owned(sessionId, taskId);
                const result = yield* readResult(sessionId, taskId);
                if (result !== null) {
                  const end = Math.min(offset + 4000, result.result.length);
                  return {
                    taskId,
                    status: result.status,
                    result: result.result.slice(offset, end),
                    offset,
                    nextOffset: end < result.result.length ? end : null,
                    length: result.result.length,
                  };
                }
                return { taskId, status: detail.attempts.at(-1)?.status ?? "interrupted" };
              }),
            ),
          ),
          toolDefinition({
            name: "cancel_background_task",
            description:
              "Stop one background task in this session and await its cleanup. Does not undo effects already performed.",
            inputSchema: toToolSchema(ResultInput),
          }).server(({ taskId }) =>
            run(
              Effect.gen(function* () {
                yield* owned(sessionId, taskId);
                yield* FiberMap.remove(fibers, taskId);
                return { taskId, status: "stopped" as const };
              }),
            ),
          ),
        ];
      }),
  };
});

export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  Effect.Success<typeof make>
>()("memory-agent/tools/background/BackgroundTasks") {
  static readonly layer = Layer.effect(BackgroundTasks, make);
}
