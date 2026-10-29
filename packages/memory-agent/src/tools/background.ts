import {
  HashMap,
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { RunStore } from "../loop/store.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { AttemptFailureReason } from "../work-trace/contracts.ts";
import { WorkTraceStore } from "../work-trace/store.ts";
import { runTool, type RunTool } from "./run-tool.ts";
import { failureAnnotations, failureTags } from "../runtime/logged-failures.ts";
import { SqlClient, SqlSchema } from "effect/sql";

export interface BackgroundBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly abortSignal: AbortSignal;
}

export class BackgroundOperationFailed extends Schema.TaggedError<
  BackgroundOperationFailed,
  { readonly brand: unique symbol }
>()("BackgroundOperationFailed", { cause: Schema.Defect() }) {}

export class BackgroundResultStoreFailed extends Schema.TaggedError<
  BackgroundResultStoreFailed,
  { readonly brand: unique symbol }
>()("BackgroundResultStoreFailed", {
  operation: Schema.Literals(["read", "write", "decode"]),
  cause: Schema.Defect(),
}) {}

export class BackgroundTraceFailed extends Schema.TaggedError<
  BackgroundTraceFailed,
  { readonly brand: unique symbol }
>()("BackgroundTraceFailed", { cause: Schema.Defect() }) {}

/** The model reads `message`; it is fixed and names no task data. */
export class BackgroundTaskNotFound extends Schema.TaggedError<
  BackgroundTaskNotFound,
  { readonly brand: unique symbol }
>()("BackgroundTaskNotFound", { message: Schema.String }) {}

const parentInterrupted = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    const interrupt = () => resume(Effect.interrupt);
    const listen = () => signal.addEventListener("abort", interrupt, { once: true });
    // An abort before the listener fires no event, so the check and the listener are one step.
    (signal.aborted ? interrupt : listen)();
    return Effect.sync(() => signal.removeEventListener("abort", interrupt));
  });

/** Interrupts the caller when `signal` is already aborted. */
const interruptIfAborted = (signal: AbortSignal) =>
  Effect.when(
    Effect.interrupt,
    Effect.sync(() => signal.aborted),
  );

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
/** The trace event an attempt's terminal status records. */
const attemptEvent = {
  completed: "attempt_completed",
  cancelled: "attempt_cancelled",
  failed: "attempt_failed",
} as const;

const getBackgroundResult = {
  name: "get_background_result",
  description:
    "Retrieve one background shell or ACP task's saved, redacted result by taskId. Result is JSON text, paged in 4000-character chunks with nextOffset; read all required pages before relying on it. Returns running if unfinished; interrupted after restart means do not retry blindly. A notification alone is not a result.",
  parameters: ResultInput,
} as const;

const cancelBackgroundTask = {
  name: "cancel_background_task",
  description:
    "Stop one background task in this session and await its cleanup. Does not undo effects already performed.",
  parameters: ResultInput,
} as const;

const make = Effect.gen(function* () {
  const trace = yield* WorkTraceStore;
  const crypto = yield* Crypto.Crypto;
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
  const runStore = yield* RunStore;
  const redactor = yield* SecretRedactor;
  const fibers = yield* FiberMap.make<string>();
  const dispatch = yield* Semaphore.make(1);
  /** Each running task's session, by task id. */
  const sessions = yield* Ref.make(HashMap.empty<string, string>());
  const completions = yield* PubSub.unbounded<string>();
  const loadResult = Effect.fn("BackgroundTasks.loadResult")(function* (taskId: string) {
    const saved = yield* Effect.mapError(runStore.metadata.get(namespace, taskId), (cause) =>
      BackgroundResultStoreFailed.make({ operation: "read", cause }),
    );
    return yield* Option.match(saved, {
      onNone: () => Effect.succeedNone,
      onSome: (value) =>
        Schema.decodeUnknownEffect(SavedResult)(value).pipe(
          Effect.asSome,
          Effect.mapError((cause) =>
            BackgroundResultStoreFailed.make({ operation: "decode", cause }),
          ),
        ),
    });
  });
  const traceEffect = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.mapError(effect, (cause) => BackgroundTraceFailed.make({ cause }));

  const owned = Effect.fn("BackgroundTasks.owned")(function* (sessionId: string, taskId: string) {
    const detail = yield* traceEffect(trace.taskDetail(sessionId, taskId));
    return yield* Effect.fromOption(
      Option.fromNullishOr(detail).pipe(
        Option.filter(
          ({ task }) =>
            task.agentName.startsWith("background_") &&
            task.deletedAt === null &&
            task.deleteRequestedAt === null,
        ),
      ),
      () => BackgroundTaskNotFound.make({ message: "Background task not found in this session" }),
    );
  });

  /** What a task that failed without a saved result reads as. */
  const storageFailed = {
    status: "failed" as const,
    result:
      "Result unavailable: background_result_storage_failed. Inspect recorded effects before retrying.",
  };
  const readResult = Effect.fn("BackgroundTasks.readResult")(function* (
    sessionId: string,
    taskId: string,
  ) {
    const detail = yield* owned(sessionId, taskId);
    const saved = yield* loadResult(taskId);
    return Option.getOrNull(
      Option.orElse(saved, () =>
        Option.liftPredicate(storageFailed, () => detail.attempts.at(-1)?.status === "failed"),
      ),
    );
  });

  const start = Effect.fn("BackgroundTasks.start")(function* (
    binding: BackgroundBinding,
    toolCallId: string,
    kind: "shell" | "external_agent",
    request: string,
    operation: Effect.Effect<BackgroundOutcome, BackgroundOperationFailed>,
  ) {
    yield* interruptIfAborted(binding.abortSignal);
    const hiddenRequest = yield* redactor.redactText(request);
    const launch = Effect.gen(function* () {
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
          threadId: `background-${yield* traceEffect(crypto.randomUUIDv4())}`,
        }),
      );
      yield* Ref.update(sessions, HashMap.set(handle.taskId, binding.sessionId));
      const save = Effect.fn("BackgroundTasks.saveResult")(function* (
        status: typeof SavedResult.Type.status,
        result: string,
      ) {
        const hidden = yield* redactor.redactText(result);
        yield* Effect.mapError(
          runStore.metadata.set(namespace, handle.taskId, { status, result: hidden.text }),
          (cause) => BackgroundResultStoreFailed.make({ operation: "write", cause }),
        );
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
        const recorded = Exit.match(stored, {
          onSuccess: () => ({ failure, stage: "process" as const }),
          onFailure: () => ({
            failure: AttemptFailureReason.cases.ResultStorageFailed.make({}),
            stage: "finish" as const,
          }),
        });
        const failed = Option.map(Option.fromNullishOr(recorded.failure), (reason) => ({
          reason,
          stage: recorded.stage,
        }));
        const status = Option.match(failed, {
          onSome: () => "failed" as const,
          onNone: () =>
            saved.status === "cancelled" ? ("cancelled" as const) : ("completed" as const),
        });
        yield* traceEffect(
          trace.transitionAttempt(
            handle,
            binding.sessionId,
            status,
            attemptEvent[status],
            Exit.match(stored, {
              onSuccess: () =>
                `Background ${kind} ${status}; retrieve with get_background_result taskId ${handle.taskId}`,
              onFailure: () =>
                `Background ${kind} ended but result storage failed; inspect effects before retrying`,
            }),
            Option.getOrNull(failed),
            false,
            binding.runId,
          ),
        );
        yield* PubSub.publish(completions, binding.sessionId);
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
                ...failureAnnotations(error),
              }),
            ),
          ),
        ),
        Effect.exit,
        Effect.asVoid,
        Effect.ensuring(Ref.update(sessions, HashMap.remove(handle.taskId))),
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
    });
    return yield* dispatch.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* interruptIfAborted(binding.abortSignal);
          const prior = yield* priorDispatch({
            idempotencyKey: `${binding.runId}:${toolCallId}`,
            sessionId: binding.sessionId,
            agentName: `background_${kind}`,
          });
          return yield* Option.match(prior, {
            onSome: (dispatched) =>
              Effect.succeed({
                ...dispatched,
                nextAction:
                  "This operation was already dispatched. Retrieve its result; do not resend it.",
              }),
            onNone: () => launch,
          });
        }),
      ),
    );
  });

  /** The tools' calls in `sessionId`. */
  const callsFor = (sessionId: string) => ({
    getResult: ({ taskId, offset = 0 }: typeof ResultInput.Type) =>
      Effect.gen(function* () {
        const detail = yield* owned(sessionId, taskId);
        const result = yield* readResult(sessionId, taskId);
        return Option.match(Option.fromNullishOr(result), {
          onNone: () => ({ taskId, status: detail.attempts.at(-1)?.status ?? "interrupted" }),
          onSome: (found) => {
            const end = Math.min(offset + 4000, found.result.length);
            return {
              taskId,
              status: found.status,
              result: found.result.slice(offset, end),
              offset,
              nextOffset: end < found.result.length ? end : null,
              length: found.result.length,
            };
          },
        });
      }),
    cancel: ({ taskId }: typeof ResultInput.Type) =>
      Effect.gen(function* () {
        yield* owned(sessionId, taskId);
        yield* FiberMap.remove(fibers, taskId);
        return { taskId, status: "stopped" as const };
      }),
  });

  return {
    start,
    waitResult: Effect.fn("BackgroundTasks.waitResult")(function* (
      sessionId: string,
      taskId: string,
      milliseconds: number,
    ) {
      // One read, then a wait for the next trace change when there was no result yet.
      const poll = Effect.gen(function* () {
        const cursor = yield* traceEffect(trace.latestCursor(sessionId));
        const result = Option.fromNullishOr(yield* readResult(sessionId, taskId));
        yield* Effect.when(
          traceEffect(trace.waitForChangeEffect({ sessionId, afterCursor: cursor })),
          Effect.succeed(Option.isNone(result)),
        );
        return result;
      });
      const waited = Effect.gen(function* () {
        const result = Option.flatten(
          yield* poll.pipe(
            Effect.repeat({ until: Option.isSome }),
            Effect.timeoutOption(milliseconds),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.when(
          sql`
            UPDATE parent_notifications
            SET delivered_to_run_id = (SELECT parent_run_id FROM work_tasks WHERE id = ${taskId}),
              delivered_at = ${now}
            WHERE task_id = ${taskId} AND delivered_at IS NULL`,
          Effect.succeed(Option.isSome(result)),
        );
        return Option.getOrNull(result);
      });
      return yield* milliseconds === 0 ? readResult(sessionId, taskId) : waited;
    }),
    /** The session of each task as it settles. */
    completions: Stream.fromPubSub(completions),
    hasSession: (sessionId: string) =>
      Effect.map(Ref.get(sessions), (running) => HashMap.some(running, (id) => id === sessionId)),
    stopTask(taskId: string) {
      return FiberMap.remove(fibers, taskId);
    },
    stopSession: Effect.fn("BackgroundTasks.stopSession")(function* (sessionId: string) {
      yield* Effect.forEach(
        HashMap.keys(HashMap.filter(yield* Ref.get(sessions), (id) => id === sessionId)),
        (taskId) => FiberMap.remove(fibers, taskId),
        { concurrency: "unbounded", discard: true },
      );
    }),
    /** The tools run on the loop's fiber, so their spans join the run's trace. */
    toolsFor: (sessionId: string): RunTool[] => {
      const calls = callsFor(sessionId);
      return [
        runTool({ ...getBackgroundResult, handler: calls.getResult }),
        runTool({ ...cancelBackgroundTask, lazy: true, handler: calls.cancel }),
      ];
    },
  };
});

export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  Effect.Success<typeof make>
>()("memory-agent/tools/background/BackgroundTasks") {
  static readonly layer = Layer.effect(BackgroundTasks, make);
}
