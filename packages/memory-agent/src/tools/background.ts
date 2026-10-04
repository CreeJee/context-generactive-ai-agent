import { randomUUID } from "node:crypto";
import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Context, Data, Effect, FiberMap, Layer, Option, Schema } from "effect";
import { ChatState } from "../chat-state/chat-state.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { WorkTraceStore } from "../work-trace/store.ts";
import { toToolSchema } from "./schema.ts";
import { Database } from "../db/database.ts";

export interface BackgroundBinding {
  readonly sessionId: string;
  readonly runId: string;
  readonly abortSignal: AbortSignal;
}

export class BackgroundOperationFailed extends Data.TaggedError("BackgroundOperationFailed")<{
  readonly cause: unknown;
}> {}

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
  const { sqlite } = yield* Database;
  const state = yield* ChatState;
  const redactor = yield* SecretRedactor;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const fibers = yield* FiberMap.make<string>();
  const sessions = new Map<string, string>();
  let onCompletion: ((sessionId: string) => void) | undefined;
  const loadResult = Effect.fn("BackgroundTasks.loadResult")(function* (taskId: string) {
    const saved = yield* Effect.tryPromise({
      try: () => state.persistence.stores.metadata.get(namespace, taskId),
      catch: (cause) => new BackgroundOperationFailed({ cause }),
    });
    return saved === null ? null : Schema.decodeUnknownSync(SavedResult)(saved);
  });

  const start = Effect.fn("BackgroundTasks.start")(function* (
    binding: BackgroundBinding,
    toolCallId: string,
    kind: "shell" | "external_agent",
    request: string,
    operation: (signal: AbortSignal) => Promise<string>,
  ) {
    if (binding.abortSignal.aborted) return yield* Effect.interrupt;
    const prior = sqlite
      .prepare(
        `SELECT t.id AS taskId, a.id AS attemptId, a.status
         FROM agent_invocations i JOIN work_tasks t ON t.id = i.task_id
         JOIN agent_run_attempts a ON a.invocation_id = i.id
         WHERE i.idempotency_key = ? AND t.origin_session_id = ? AND t.agent_name = ?`,
      )
      .get(`${binding.runId}:${toolCallId}`, binding.sessionId, `background_${kind}`);
    if (prior) {
      const previous = Schema.decodeUnknownSync(
        Schema.Struct({ taskId: Schema.String, attemptId: Schema.String, status: Schema.String }),
      )(prior);
      return {
        ...previous,
        nextAction: "This operation was already dispatched. Retrieve its result; do not resend it.",
      };
    }
    const hiddenRequest = yield* redactor.redactText(request);
    const handle = trace.startAttempt({
      sessionId: binding.sessionId,
      parentRunId: binding.runId,
      parentToolCallId: toolCallId,
      agentId: null,
      agentName: `background_${kind}`,
      title: hiddenRequest.text.replace(/\s+/gu, " ").slice(0, 80),
      request: hiddenRequest.text,
      kind: "start",
      threadId: `background-${randomUUID()}`,
    });
    sessions.set(handle.taskId, binding.sessionId);
    let pending: Promise<string> | undefined;
    const save = (status: typeof SavedResult.Type.status, result: string) =>
      Effect.gen(function* () {
        const hidden = yield* redactor.redactText(result);
        yield* Effect.tryPromise({
          try: () =>
            state.persistence.stores.metadata.set(namespace, handle.taskId, {
              status,
              result: hidden.text,
            }),
          catch: (cause) => new BackgroundOperationFailed({ cause }),
        });
        trace.transitionAttempt(
          handle,
          binding.sessionId,
          status,
          status === "completed"
            ? "attempt_completed"
            : status === "cancelled"
              ? "attempt_cancelled"
              : "attempt_failed",
          `Background ${kind} ${status}; retrieve with get_background_result taskId ${handle.taskId}`,
          null,
          false,
          binding.runId,
        );
      });
    const job = Effect.gen(function* () {
      trace.transitionAttempt(
        handle,
        binding.sessionId,
        "running",
        "attempt_started",
        `Background ${kind} started`,
      );
      const result = yield* Effect.tryPromise({
        try: (signal) => {
          pending = operation(AbortSignal.any([signal, binding.abortSignal]));
          return pending;
        },
        catch: (cause) => new BackgroundOperationFailed({ cause }),
      });
      yield* save(binding.abortSignal.aborted ? "cancelled" : "completed", result);
    }).pipe(
      Effect.catch((error) =>
        save(
          binding.abortSignal.aborted ? "cancelled" : "failed",
          error.cause instanceof Error ? error.cause.message : String(error.cause),
        ),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          if (pending) yield* Effect.promise(() => pending!.catch(() => ""));
          yield* save("cancelled", "Operation stopped. Inspect its effects before retrying.");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          sessions.delete(handle.taskId);
          onCompletion?.(binding.sessionId);
        }),
      ),
    );
    yield* FiberMap.run(fibers, handle.taskId, job);
    return {
      status: "running" as const,
      taskId: handle.taskId,
      attemptId: handle.id,
      nextAction:
        "Continue independent work. Retrieve the result with get_background_result after completion.",
    };
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
          const cursor = trace.latestCursor(sessionId);
          const result = yield* loadResult(taskId);
          if (result !== null) return result;
          yield* Effect.tryPromise({
            try: (signal) => trace.waitForChange(sessionId, cursor, signal),
            catch: (cause) => new BackgroundOperationFailed({ cause }),
          });
        }
      });
      if (milliseconds === 0) return yield* loadResult(taskId);
      const result = Option.getOrNull(yield* waiting.pipe(Effect.timeoutOption(milliseconds)));
      if (result !== null)
        sqlite
          .prepare(
            "UPDATE parent_notifications SET delivered_to_run_id = (SELECT parent_run_id FROM work_tasks WHERE id = ?), delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL",
          )
          .run(taskId, Date.now(), taskId);
      return result;
    }),
    onCompletion(listener: (sessionId: string) => void) {
      onCompletion = listener;
    },
    hasSession(sessionId: string) {
      return [...sessions.values()].includes(sessionId);
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
    forSession(sessionId: string): AnyServerTool[] {
      const owned = (taskId: string) => {
        const detail = trace.taskDetail(sessionId, taskId);
        if (
          !detail ||
          !detail.task.agentName.startsWith("background_") ||
          detail.task.deletedAt !== null ||
          detail.task.deleteRequestedAt !== null
        )
          throw new Error("Background task not found in this session");
        return detail;
      };
      return [
        toolDefinition({
          name: "get_background_result",
          description:
            "Retrieve one background shell or ACP task's saved, redacted result by taskId. Result is JSON text, paged in 4000-character chunks with nextOffset; read all required pages before relying on it. Returns running if unfinished; interrupted after restart means do not retry blindly. A notification alone is not a result.",
          inputSchema: toToolSchema(ResultInput),
        }).server(async ({ taskId, offset = 0 }) => {
          const detail = owned(taskId);
          const saved = await state.persistence.stores.metadata.get(namespace, taskId);
          if (saved !== null) {
            const result = Schema.decodeUnknownSync(SavedResult)(saved);
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
        toolDefinition({
          name: "cancel_background_task",
          description:
            "Stop one background task in this session and await its cleanup. Does not undo effects already performed.",
          inputSchema: toToolSchema(ResultInput),
        }).server(async ({ taskId }) => {
          owned(taskId);
          await run(FiberMap.remove(fibers, taskId));
          return { taskId, status: "stopped" as const };
        }),
      ];
    },
  };
});

export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  Effect.Success<typeof make>
>()("memory-agent/BackgroundTasks") {
  static readonly layer = Layer.effect(BackgroundTasks, make);
}
