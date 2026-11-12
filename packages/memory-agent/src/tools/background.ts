import {
  HashMap,
  Cause,
  Clock,
  Context,
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
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { BackgroundKind, RunningBackgroundTask } from "../agent/run-state.ts";
import { AppEvents } from "../events/app-events.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { runTool, type RunTool } from "./run-tool.ts";
import { failureAnnotations, failureTags } from "../runtime/logged-failures.ts";

export interface BackgroundBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly abortSignal: AbortSignal;
}

export class BackgroundOperationFailed extends Schema.TaggedError<
  BackgroundOperationFailed,
  { readonly brand: unique symbol }
>()("BackgroundOperationFailed", { cause: Schema.Defect() }) {}

export class BackgroundStoreFailed extends Schema.TaggedError<
  BackgroundStoreFailed,
  { readonly brand: unique symbol }
>()("BackgroundStoreFailed", {
  operation: Schema.Literals(["read", "write", "decode"]),
  cause: Schema.Defect(),
}) {}

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

/** How a background task ended. A command that exited non-zero still completed, with its output. */
const EndedStatus = Schema.Literals(["completed", "failed", "cancelled", "interrupted"]);
const Running = Schema.Literal("running");

/** A task's saved result, once it ended. */
const EndedTask = Schema.Struct({ status: EndedStatus, result: Schema.String });
export type BackgroundResult = typeof EndedTask.Type;
/** A task as its row stands: running without a result, or ended with one. */
const TaskRow = Schema.Union([Schema.Struct({ status: Running, result: Schema.Null }), EndedTask]);

/** A task's end that its session has not been told of yet. */
export interface BackgroundEnd {
  readonly taskId: string;
  /** The run that started the task: a chat run, or one of the kanban board's (`isBoardRun`). */
  readonly parentRunId: string;
  readonly kind: BackgroundKind;
  readonly title: string;
  readonly status: BackgroundResult["status"];
}

const EndRow = Schema.Struct({
  id: Schema.String,
  parent_run_id: Schema.String,
  kind: BackgroundKind,
  title: Schema.String,
  status: EndedStatus,
});
const RunningRow = Schema.Struct({
  id: Schema.String,
  kind: BackgroundKind,
  title: Schema.String,
  started_at: Schema.Finite,
});

const ResultInput = Schema.Struct({
  taskId: Schema.NonEmptyString,
  offset: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});

const getBackgroundResult = {
  name: "get_background_result",
  description:
    "Retrieve one background task's saved, redacted result by taskId: a sh skill run or an external agent's (ACP) turn. Result is JSON text, paged in 4000-character chunks with nextOffset; read all required pages before relying on it. Returns running if unfinished; interrupted after restart means do not retry blindly. A notification alone is not a result.",
  parameters: ResultInput,
} as const;

const cancelBackgroundTask = {
  name: "cancel_background_task",
  description:
    "Stop one background task in this session and await its cleanup. Does not undo effects already performed.",
  parameters: ResultInput,
} as const;

/**
 * What a task still running tells the model. The server waits for it: the session's Plan holds
 * until it ends, and its notification starts the next turn.
 */
const awaitedByServer =
  "Do not poll it or watch its progress: end your turn when nothing else is left, and its completion notification starts your next turn.";

/** What a task whose end could not be saved reads as. */
const endNotSaved: BackgroundResult = {
  status: "failed",
  result: "Result unavailable: its end could not be saved. Inspect its effects before retrying.",
};

/** What a task the previous process left running reads as. */
const restartedResult =
  "Stopped by a server restart before it finished. Inspect its effects before retrying.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const redactor = yield* SecretRedactor;
  const events = yield* AppEvents;
  const fibers = yield* FiberMap.make<string>();
  const dispatch = yield* Semaphore.make(1);
  /** Each running task's session, by task id. */
  const sessions = yield* Ref.make(HashMap.empty<string, string>());
  /** Each task as it ends, with its session. */
  const settled = yield* PubSub.unbounded<{
    readonly taskId: string;
    readonly sessionId: string;
  }>();

  const stored =
    (operation: BackgroundStoreFailed["operation"]) =>
    <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.mapError(effect, (cause) =>
        BackgroundStoreFailed.make({
          operation: cause._tag === "SchemaError" ? "decode" : operation,
          cause,
        }),
      );

  // Tasks the previous process left running ended with it; their end is told like any other.
  yield* Effect.flatMap(
    Clock.currentTimeMillis,
    (now) =>
      sql`UPDATE background_tasks
      SET status = 'interrupted', result = ${restartedResult}, finished_at = ${now}
      WHERE status = 'running'`,
  ).pipe(stored("write"));

  const selectTask = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, taskId: Schema.String }),
    Result: TaskRow,
    execute: ({ sessionId, taskId }) =>
      sql`SELECT status, result FROM background_tasks
        WHERE id = ${taskId} AND session_id = ${sessionId}`,
  });
  const owned = Effect.fn("BackgroundTasks.owned")(function* (sessionId: string, taskId: string) {
    return yield* Effect.fromOption(yield* stored("read")(selectTask({ sessionId, taskId })), () =>
      BackgroundTaskNotFound.make({ message: "Background task not found in this session" }),
    );
  });
  /**
   * The task as the model reads it. One the database still has running but that runs no more in
   * this process could not save its end.
   */
  const current = Effect.fn("BackgroundTasks.current")(function* (
    sessionId: string,
    taskId: string,
  ) {
    const task = yield* owned(sessionId, taskId);
    const live = HashMap.has(yield* Ref.get(sessions), taskId);
    return task.status === "running" && !live ? endNotSaved : task;
  });
  /** The task's result once it ended. */
  const ended = (sessionId: string, taskId: string) =>
    Effect.map(current(sessionId, taskId), Option.liftPredicate(Schema.is(EndedTask)));

  const selectPrior = SqlSchema.findOneOption({
    Request: Schema.Struct({ runId: Schema.String, toolCallId: Schema.String }),
    Result: Schema.Struct({ taskId: Schema.String, status: Schema.Union([Running, EndedStatus]) }),
    execute: ({ runId, toolCallId }) =>
      sql`SELECT id AS taskId, status FROM background_tasks
        WHERE parent_run_id = ${runId} AND tool_call_id = ${toolCallId}`,
  });

  const start = Effect.fn("BackgroundTasks.start")(function* (
    binding: BackgroundBinding,
    toolCallId: string,
    kind: BackgroundKind,
    request: string,
    /** The report the task saves when it ends; the model reads it with get_background_result. */
    operation: Effect.Effect<string, BackgroundOperationFailed>,
  ) {
    yield* interruptIfAborted(binding.abortSignal);
    const { sessionId } = binding;
    const hiddenRequest = yield* redactor.redactText(request);
    const launch = Effect.gen(function* () {
      const taskId = yield* crypto.uuidV4();
      yield* stored("write")(
        Effect.flatMap(
          Clock.currentTimeMillis,
          (now) => sql`INSERT INTO background_tasks
            (id, session_id, parent_run_id, tool_call_id, kind, title, status, started_at)
            VALUES (${taskId}, ${sessionId}, ${binding.runId}, ${toolCallId}, ${kind},
              ${hiddenRequest.text.replace(/\s+/gu, " ").slice(0, 80)}, 'running', ${now})`,
        ),
      );
      yield* Ref.update(sessions, HashMap.set(taskId, sessionId));
      const finish = Effect.fn("BackgroundTasks.finish")(function* (
        exit: Exit.Exit<string, BackgroundOperationFailed>,
      ) {
        const end = Exit.match(exit, {
          onSuccess: (report): BackgroundResult => ({ status: "completed", result: report }),
          onFailure: (cause): BackgroundResult =>
            Cause.hasInterrupts(cause)
              ? {
                  status: "cancelled",
                  result: "Operation stopped. Inspect its effects before retrying.",
                }
              : // Tags only: the cause can hold command output, paths or provider text.
                {
                  status: "failed",
                  result: `Operation failed (${failureTags(cause)}). Inspect its effects before retrying.`,
                },
        });
        const hidden = yield* redactor.redactText(end.result);
        const now = yield* Clock.currentTimeMillis;
        yield* stored("write")(sql`UPDATE background_tasks
          SET status = ${end.status}, result = ${hidden.text}, finished_at = ${now}
          WHERE id = ${taskId}`);
      });
      const job = Effect.raceFirst(operation, parentInterrupted(binding.abortSignal)).pipe(
        Effect.onExit((exit) =>
          finish(exit).pipe(
            Effect.catch((error) =>
              Effect.logError("Background task end not recorded", {
                taskId,
                ...failureAnnotations(error),
              }),
            ),
          ),
        ),
        Effect.exit,
        // Off the running list before the wakeup, which holds the session's Plan while its
        // background work runs.
        Effect.ensuring(
          Ref.update(sessions, HashMap.remove(taskId)).pipe(
            Effect.andThen(PubSub.publish(settled, { taskId, sessionId })),
            Effect.andThen(events.publishSession(sessionId, "run-state")),
          ),
        ),
        Effect.asVoid,
      );
      yield* FiberMap.run(fibers, taskId, Effect.interruptible(job));
      yield* events.publishSession(sessionId, "run-state");
      return {
        status: "running" as const,
        taskId,
        nextAction: `Continue independent work. ${awaitedByServer} Retrieve the result with get_background_result then.`,
      };
    });
    return yield* dispatch.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* interruptIfAborted(binding.abortSignal);
          const prior = yield* stored("read")(selectPrior({ runId: binding.runId, toolCallId }));
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
      Effect.map(current(sessionId, taskId), (task) => {
        if (task.status === "running")
          return { taskId, status: task.status, nextAction: awaitedByServer };
        const end = Math.min(offset + 4000, task.result.length);
        return {
          taskId,
          status: task.status,
          result: task.result.slice(offset, end),
          offset,
          nextOffset: end < task.result.length ? end : null,
          length: task.result.length,
        };
      }),
    cancel: ({ taskId }: typeof ResultInput.Type) =>
      Effect.gen(function* () {
        yield* owned(sessionId, taskId);
        yield* FiberMap.remove(fibers, taskId);
        return { taskId, status: "stopped" as const };
      }),
  });

  const selectUntold = SqlSchema.findAll({
    Request: Schema.String,
    Result: EndRow,
    execute: (sessionId) =>
      sql`SELECT id, parent_run_id, kind, title, status FROM background_tasks
        WHERE session_id = ${sessionId} AND finished_at IS NOT NULL AND delivered_at IS NULL
        ORDER BY finished_at, id`,
  });
  const selectRunning = SqlSchema.findAll({
    Request: Schema.String,
    Result: RunningRow,
    execute: (sessionId) =>
      sql`SELECT id, kind, title, started_at FROM background_tasks
        WHERE session_id = ${sessionId} AND status = 'running' ORDER BY started_at, id`,
  });

  return {
    start,
    /**
     * The task's result once it ends, waiting at most `milliseconds`; null while it still runs. The
     * run that waited read the result, so its end is not told again.
     */
    waitResult: Effect.fn("BackgroundTasks.waitResult")(function* (
      sessionId: string,
      taskId: string,
      milliseconds: number,
    ) {
      const waited = Effect.scoped(
        Effect.gen(function* () {
          // Subscribed before the read, so an end between the two is not missed.
          const ends = yield* PubSub.subscribe(settled);
          const awaitEnd = PubSub.take(ends).pipe(
            Effect.repeat({ until: (end) => end.taskId === taskId }),
            Effect.andThen(ended(sessionId, taskId)),
          );
          return yield* Effect.flatMap(
            ended(sessionId, taskId),
            Option.match({ onSome: Effect.succeedSome, onNone: () => awaitEnd }),
          ).pipe(Effect.timeoutOption(milliseconds), Effect.map(Option.flatten));
        }),
      );
      const result = yield* milliseconds === 0 ? ended(sessionId, taskId) : waited;
      yield* Effect.when(
        stored("write")(
          Effect.flatMap(
            Clock.currentTimeMillis,
            (now) => sql`UPDATE background_tasks
              SET delivered_to_run_id = parent_run_id, delivered_at = ${now}
              WHERE id = ${taskId} AND delivered_at IS NULL`,
          ),
        ),
        Effect.succeed(Option.isSome(result)),
      );
      return Option.getOrNull(result);
    }),
    /**
     * Takes the session's task ends not told yet for the run `runId`, oldest first. The run gives
     * them back with `release` when it does not finish.
     */
    consume: (sessionId: string, runId: string) =>
      Effect.gen(function* () {
        const rows = yield* selectUntold(sessionId);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE background_tasks SET delivered_to_run_id = ${runId}, delivered_at = ${now}
          WHERE session_id = ${sessionId} AND finished_at IS NOT NULL AND delivered_at IS NULL`;
        return rows.map((row): BackgroundEnd => ({
          taskId: row.id,
          parentRunId: row.parent_run_id,
          kind: row.kind,
          title: row.title,
          status: row.status,
        }));
      }).pipe(sql.withTransaction, stored("write")),
    /** Gives the ends the run `runId` took back to the session's next run. */
    release: (sessionId: string, runId: string) =>
      stored("write")(
        sql`UPDATE background_tasks SET delivered_to_run_id = NULL, delivered_at = NULL
          WHERE session_id = ${sessionId} AND delivered_to_run_id = ${runId}`,
      ).pipe(Effect.asVoid),
    /** Whether the session has an end to be told, unless the user stopped its notifications. */
    untold: (sessionId: string) =>
      stored("read")(
        sql`SELECT 1 FROM background_tasks b
          WHERE b.session_id = ${sessionId} AND b.finished_at IS NOT NULL
            AND b.delivered_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM parent_notification_holds h WHERE h.session_id = b.session_id
            )
          LIMIT 1`,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    /** The session's tasks still going, oldest first. */
    running: (sessionId: string) =>
      Effect.map(stored("read")(selectRunning(sessionId)), (rows) =>
        rows.map((row): RunningBackgroundTask => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          startedAt: row.started_at,
        })),
      ),
    /** The session of each task as it ends. */
    completions: Stream.map(Stream.fromPubSub(settled), ({ sessionId }) => sessionId),
    hasSession: (sessionId: string) =>
      Effect.map(Ref.get(sessions), (running) => HashMap.some(running, (id) => id === sessionId)),
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
