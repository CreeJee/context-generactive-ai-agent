import { Cause, Deferred, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { ChatState } from "../../src/chat-state/chat-state.ts";
import { ApprovedTools } from "../../src/tools/approved.ts";
import {
  BackgroundOperationFailed,
  BackgroundResultStoreFailed,
  BackgroundTasks,
} from "../../src/tools/background.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { freshSession, sdk } from "./agent-env.ts";
import { sqlGet, sqlRun, sqlExec } from "../support/sql.ts";

const Receipt = Schema.Struct({
  status: Schema.Literal("running"),
  taskId: Schema.String,
  attemptId: Schema.String,
});
const Page = Schema.Struct({
  status: Schema.String,
  result: Schema.String,
  nextOffset: Schema.NullOr(Schema.Finite),
});

/** A run of the session to start background work from; run and call IDs are global. */
const runOf = Effect.fnUntraced(function* (sessionId: string, abortSignal?: AbortSignal) {
  return {
    sessionId,
    runId: `${sessionId}:run`,
    abortSignal: abortSignal ?? (yield* Effect.abortSignal),
  };
});

/** Read a stored result through the session's `get_background_result` tool. */
const readResult = Effect.fnUntraced(function* (
  sessionId: string,
  input: { readonly taskId: string; readonly offset?: number },
) {
  const tasks = yield* BackgroundTasks;
  return yield* sdk(() => tasks.forSession(sessionId)[0]!.execute!(input));
});

/** The rejection of a tool call that must fail; a call that succeeds fails the test as a defect. */
const rejection = <A, R>(operation: Effect.Effect<A, Cause.UnknownError, R>) =>
  operation.pipe(
    Effect.flip,
    Effect.orDie,
    Effect.map((error) => error.cause),
  );

testAgent()("background task lifecycle", (it) => {
  it.effect("replayed calls, simultaneous or after completion, run the operation once", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const run = yield* runOf(sessionId);
      const callId = `${sessionId}:call`;
      const executions = yield* Ref.make(0);
      const operation = Ref.update(executions, (count) => count + 1).pipe(Effect.as("done"));
      const [first, second] = yield* Effect.all(
        [
          tasks.start(run, callId, "shell", "task", operation),
          tasks.start(run, callId, "shell", "task", operation),
        ],
        { concurrency: "unbounded" },
      );
      expect(first.taskId).toBe(second.taskId);
      yield* tasks.waitResult(sessionId, first.taskId, 2000);
      expect(yield* tasks.start(run, callId, "shell", "task", operation)).toMatchObject({
        taskId: first.taskId,
        attemptId: first.attemptId,
        status: "completed",
      });
      expect(yield* Ref.get(executions)).toBe(1);
    }),
  );

  it.effect("malformed persisted results fail in the typed storage channel", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const { persistence } = yield* ChatState;
      const receipt = yield* tasks.start(
        yield* runOf(sessionId),
        `${sessionId}:call`,
        "shell",
        "task",
        Effect.succeed("done"),
      );
      yield* tasks.waitResult(sessionId, receipt.taskId, 2000);
      yield* sdk(() =>
        persistence.stores.metadata.set("background-task-result", receipt.taskId, {
          status: "completed",
        }),
      );
      expect(yield* Effect.flip(tasks.waitResult(sessionId, receipt.taskId, 0))).toBeInstanceOf(
        BackgroundResultStoreFailed,
      );
    }),
  );

  it.effect("operation failure is stored once and finalizes the attempt as failed", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const receipt = yield* tasks.start(
        yield* runOf(sessionId),
        `${sessionId}:call`,
        "shell",
        "failing task",
        Effect.fail(new BackgroundOperationFailed({ cause: new Error("execution failed") })),
      );
      const result = yield* tasks.waitResult(sessionId, receipt.taskId, 2000);
      expect(result).toMatchObject({ status: "failed" });
      expect(result?.result).toContain("execution failed");
      expect(
        (yield* (yield* WorkTraceStore).taskDetail(sessionId, receipt.taskId))?.task.status,
      ).toBe("failed");
    }),
  );

  it.effect(
    "parent interruption awaits the operation finalizer before recording cancellation",
    () =>
      Effect.gen(function* () {
        const sessionId = yield* freshSession;
        const tasks = yield* BackgroundTasks;
        // This test represents an external SDK caller cancelling its own request.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const started = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
        const receipt = yield* tasks.start(
          yield* runOf(sessionId, controller.signal),
          `${sessionId}:call`,
          "external_agent",
          "task",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            ),
          ),
        );
        yield* Deferred.await(started);
        controller.abort();
        yield* Deferred.await(cleaning);
        expect(yield* readResult(sessionId, { taskId: receipt.taskId })).toMatchObject({
          status: "running",
        });
        yield* Deferred.succeed(finish, undefined);
        expect(yield* tasks.waitResult(sessionId, receipt.taskId, 2000)).toMatchObject({
          status: "cancelled",
        });
      }),
  );

  it.effect("paged results stay bounded and task deletion clears their stored payload", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const trace = yield* WorkTraceStore;
      const { persistence } = yield* ChatState;
      const receipt = yield* tasks.start(
        yield* runOf(sessionId),
        `${sessionId}:call`,
        "external_agent",
        "task",
        Effect.succeed("x".repeat(6000)),
      );
      yield* tasks.waitResult(sessionId, receipt.taskId, 2000);
      expect(yield* readResult(sessionId, { taskId: receipt.taskId })).toMatchObject({
        result: "x".repeat(4000),
        nextOffset: 4000,
      });
      expect(yield* readResult(sessionId, { taskId: receipt.taskId, offset: 4000 })).toMatchObject({
        result: "x".repeat(2000),
        nextOffset: null,
      });
      const requested = yield* trace.requestTaskLifecycle({
        sessionId,
        taskId: receipt.taskId,
        intent: "delete",
        idempotencyKey: `${sessionId}:delete`,
      });
      switch (requested.status) {
        case "requested":
          expect((yield* trace.finalizeTaskLifecycle(requested.operationId)).status).toBe(
            "completed",
          );
          break;
        default:
          expect.unreachable(`delete not requested: ${requested.status}`);
      }
      expect(
        yield* sdk(() => persistence.stores.metadata.get("background-task-result", receipt.taskId)),
      ).toBeNull();
      expect(yield* rejection(readResult(sessionId, { taskId: receipt.taskId }))).toMatchObject({
        message: expect.stringContaining("not found"),
      });
    }),
  );
});

// The spy and the completion listener replace parts of the block's agent, so the test owns it.
testAgent()("background result storage failure", (it) => {
  it.effect(
    "persistent result write failure records a terminal failure without retry or false completion",
    () =>
      Effect.gen(function* () {
        const { session } = yield* TestEnv;
        const tasks = yield* BackgroundTasks;
        const { metadata } = (yield* ChatState).persistence.stores;
        const original = metadata.set.bind(metadata);
        let resultWrites = 0;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(metadata, "set").mockImplementation((namespace, key, value) => {
              if (namespace !== "background-task-result") return original(namespace, key, value);
              resultWrites++;
              return Promise.reject(new Error("storage offline"));
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        let notifications = 0;
        tasks.onCompletion(() => {
          notifications++;
        });
        const receipt = yield* tasks.start(
          yield* runOf(session.id),
          `${session.id}:call`,
          "shell",
          "task",
          Effect.succeed("operation completed"),
        );
        const result = yield* tasks.waitResult(session.id, receipt.taskId, 2000);
        expect(result).toMatchObject({ status: "failed" });
        expect(result?.result).toContain("background_result_storage_failed");
        expect(
          (yield* (yield* WorkTraceStore).taskDetail(session.id, receipt.taskId))?.task.status,
        ).toBe("failed");
        expect(yield* readResult(session.id, { taskId: receipt.taskId })).toMatchObject({
          status: "failed",
        });
        expect(resultWrites).toBe(1);
        expect(notifications).toBe(1);
        expect(tasks.hasSession(session.id)).toBe(false);
      }),
  );
});

// Read-only mode covers the whole database, so this test has a block of its own.
testAgent()("read-only background results", (it) => {
  it.effect("result retrieval neither acknowledges nor consumes a stored result", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const tasks = yield* BackgroundTasks;
      const trace = yield* WorkTraceStore;
      const receipt = yield* tasks.start(
        yield* runOf(session.id),
        `${session.id}:call`,
        "shell",
        "synthetic read-only contract",
        Effect.succeed("saved result"),
      );
      yield* tasks.waitResult(session.id, receipt.taskId, 2000);
      expect((yield* trace.taskDetail(session.id, receipt.taskId))?.task.status).toBe("completed");
      const changes = yield* sqlGet("SELECT total_changes() AS n");
      const get = tasks
        .forSession(session.id)
        .find((tool) => tool.name === "get_background_result")!;
      yield* Effect.acquireRelease(sqlExec("PRAGMA query_only = ON"), () =>
        Effect.orDie(sqlExec("PRAGMA query_only = OFF")),
      );
      const first = yield* sdk(() => get.execute!({ taskId: receipt.taskId }));
      expect(first).toMatchObject({ status: "completed", result: "saved result" });
      expect(yield* sdk(() => get.execute!({ taskId: receipt.taskId }))).toEqual(first);
      expect(yield* rejection(sdk(() => get.execute!({ taskId: "missing-task" })))).toMatchObject({
        message: expect.stringContaining("not found"),
      });
      expect(yield* sqlGet("SELECT total_changes() AS n")).toEqual(changes);
    }),
  );
});

// Reopening replaces the block's agent, so each restart test has a block of its own and reads
// services through `env.use` once it has reopened.
testAgent()("background shell across restart", (it) => {
  it.effect(
    "shell yields before completion, survives parent end, and results remain scoped and durable",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const { project, session } = env;
        const background = yield* BackgroundTasks;
        const run = yield* runOf(session.id);
        const [save, shell] = (yield* ApprovedTools).forProject(project, "gate", run);
        const script = `node -e 'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("finished")}},20)'`;
        yield* sdk(() =>
          save.execute!({ name: "wait-release", description: "Wait for release", script }),
        );
        const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
          yield* sdk(() =>
            shell.execute!(
              { name: "wait-release", yieldMs: 0, timeoutSeconds: 5 },
              {
                toolCallId: `${session.id}:shell`,
                abortSignal: run.abortSignal,
                emitCustomEvent: () => undefined,
              },
            ),
          ),
        );
        expect(background.hasSession(session.id)).toBe(true);
        expect(yield* readResult(session.id, { taskId: receipt.taskId })).toMatchObject({
          status: "running",
        });
        // Independent parent work unlocks the real child process. No wall-clock assertion.
        yield* (yield* FileSystem.FileSystem).writeFileString(
          (yield* Path.Path).join(project.root, "release"),
          "done",
        );
        const finished = yield* background.waitResult(session.id, receipt.taskId, 4000);
        expect(finished?.result).toContain("finished");
        const page = yield* Schema.decodeUnknownEffect(Page)(
          yield* readResult(session.id, { taskId: receipt.taskId }),
        );
        expect(page.status).toBe("completed");
        const other = yield* freshSession;
        expect(yield* rejection(readResult(other, { taskId: receipt.taskId }))).toMatchObject({
          message: expect.stringContaining("not found"),
        });
        yield* env.reopen;
        expect(yield* env.use(readResult(session.id, { taskId: receipt.taskId }))).toMatchObject(
          page,
        );
      }),
  );
});

testAgent()("background cancellation across restart", (it) => {
  it.effect("cancel stops active work and restart never resends an interrupted operation", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const { session } = env;
      const tasks = yield* BackgroundTasks;
      const started = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const receipt = yield* tasks.start(
        yield* runOf(session.id),
        `${session.id}:call`,
        "external_agent",
        "synthetic task",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(aborted, undefined)),
        ),
      );
      yield* Deferred.await(started);
      yield* tasks.stopSession(session.id);
      expect(yield* Deferred.isDone(aborted)).toBe(true);
      expect(yield* readResult(session.id, { taskId: receipt.taskId })).toMatchObject({
        status: "cancelled",
      });
      // Simulate a process dying after dispatch with no durable result.
      const { persistence } = yield* ChatState;
      yield* sdk(() =>
        persistence.stores.metadata.delete("background-task-result", receipt.taskId),
      );
      yield* sqlRun("UPDATE agent_run_attempts SET status='running' WHERE id=?", receipt.attemptId);
      yield* sqlRun(
        "UPDATE work_tasks SET active_attempt_id=?,status='running' WHERE id=?",
        receipt.attemptId,
        receipt.taskId,
      );
      yield* env.reopen;
      expect((yield* env.use(BackgroundTasks)).hasSession(session.id)).toBe(false);
      expect(yield* env.use(readResult(session.id, { taskId: receipt.taskId }))).toMatchObject({
        status: "interrupted",
      });
    }),
  );
});
