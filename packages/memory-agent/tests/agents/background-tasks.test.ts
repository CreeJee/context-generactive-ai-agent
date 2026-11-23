import { Deferred, Effect, Fiber, FileSystem, Path, Ref, Schema, Stream } from "effect";
import { expect } from "vite-plus/test";
import { OrchestratorNotifications } from "../../src/sessions/orchestrator-notifications.ts";
import { ApprovedTools } from "../../src/tools/approved.ts";
import { BackgroundOperationFailed, BackgroundTasks } from "../../src/tools/background.ts";
import { WorkTraceStore } from "../../src/work-trace/store.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { callTool } from "../support/run-tools.ts";
import { freshSession } from "./agent-env.ts";
import { sqlGet, sqlRun, sqlExec } from "../support/sql.ts";

const Receipt = Schema.Struct({ status: Schema.Literal("running"), taskId: Schema.String });
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
  return yield* callTool(tasks.toolsFor(sessionId), "get_background_result", input);
});

/** The background ends the run takes from the session's notifications, as their rows carry them. */
const takeEnds = Effect.fnUntraced(function* (sessionId: string, runId: string) {
  const notifications = yield* OrchestratorNotifications;
  return (yield* notifications.claim(sessionId, runId, "task")).map((entry) => entry.payload);
});

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
        status: "completed",
      });
      expect(yield* Ref.get(executions)).toBe(1);
      // Background work is not a Work Trace task.
      expect(yield* (yield* WorkTraceStore).taskTree(sessionId)).toEqual([]);
    }),
  );

  it.effect("operation failure is stored as the task's failed result", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const receipt = yield* tasks.start(
        yield* runOf(sessionId),
        `${sessionId}:call`,
        "shell",
        "failing task",
        Effect.fail(BackgroundOperationFailed.make({ cause: new Error("execution failed") })),
      );
      const result = yield* tasks.waitResult(sessionId, receipt.taskId, 2000);
      expect(result).toMatchObject({ status: "failed" });
      // The model reads the failure's tag, never the cause's text.
      expect(result?.result).toContain("BackgroundOperationFailed");
      expect(result?.result).not.toContain("execution failed");
      expect(yield* readResult(sessionId, { taskId: receipt.taskId })).toMatchObject({
        status: "failed",
      });
    }),
  );

  it.effect(
    "an end is told once to the run that takes it, and again after that run gives it back",
    () =>
      Effect.gen(function* () {
        const sessionId = yield* freshSession;
        const tasks = yield* BackgroundTasks;
        const notifications = yield* OrchestratorNotifications;
        const run = yield* runOf(sessionId);
        const gate = yield* Deferred.make<void>();
        const ended = yield* Stream.take(tasks.completions, 1).pipe(
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const receipt = yield* tasks.start(
          run,
          `${sessionId}:call`,
          "shell",
          "ls  -la",
          Effect.as(Deferred.await(gate), "listing"),
        );
        expect((yield* tasks.running(sessionId)).map((task) => task.id)).toEqual([receipt.taskId]);
        expect(yield* notifications.wakes(sessionId)).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(ended);
        expect(yield* tasks.running(sessionId)).toEqual([]);
        expect(yield* notifications.wakes(sessionId)).toBe(true);
        const told = [
          {
            _tag: "BackgroundEnd",
            taskId: receipt.taskId,
            parentRunId: run.runId,
            kind: "shell",
            title: "ls -la",
            status: "completed",
          },
        ];
        expect(yield* takeEnds(sessionId, "later-run")).toEqual(told);
        expect(yield* takeEnds(sessionId, "next-run")).toEqual([]);
        yield* notifications.release(sessionId, "later-run");
        expect(yield* takeEnds(sessionId, "next-run")).toEqual(told);
        expect(yield* notifications.wakes(sessionId)).toBe(false);
        // A result the run waited for is its own, so its end is not told again.
        const waited = yield* tasks.start(
          run,
          `${sessionId}:waited`,
          "shell",
          "pwd",
          Effect.succeed("/"),
        );
        yield* tasks.waitResult(sessionId, waited.taskId, 2000);
        expect(yield* notifications.wakes(sessionId)).toBe(false);
        expect(
          yield* sqlGet(
            "SELECT state, delivered_run_id FROM orchestrator_notifications WHERE id = ?",
            waited.taskId,
          ),
        ).toEqual({ state: "delivered", delivered_run_id: run.runId });
      }),
  );

  it.effect(
    "the end of a task the board started goes with the next run but does not wake the session",
    () =>
      Effect.gen(function* () {
        const sessionId = yield* freshSession;
        const tasks = yield* BackgroundTasks;
        const notifications = yield* OrchestratorNotifications;
        const boardRun = {
          ...(yield* runOf(sessionId)),
          runId: `kanban:${sessionId}:S1:1`,
        };
        const ended = yield* Stream.take(tasks.completions, 1).pipe(
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const receipt = yield* tasks.start(
          boardRun,
          `${sessionId}:board-call`,
          "shell",
          "pwd",
          Effect.succeed("/"),
        );
        yield* Fiber.join(ended);
        expect(yield* notifications.wakes(sessionId)).toBe(false);
        expect(yield* takeEnds(sessionId, "next-run")).toMatchObject([
          { taskId: receipt.taskId, parentRunId: boardRun.runId, status: "completed" },
        ]);
      }),
  );

  it.effect("a run that finishes delivers the ends it took", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      const notifications = yield* OrchestratorNotifications;
      const ended = yield* Stream.take(tasks.completions, 1).pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const receipt = yield* tasks.start(
        yield* runOf(sessionId),
        `${sessionId}:call`,
        "shell",
        "pwd",
        Effect.succeed("/"),
      );
      yield* Fiber.join(ended);
      const stateOf = sqlGet(
        "SELECT state, claimed_run_id, delivered_run_id FROM orchestrator_notifications WHERE id = ?",
        receipt.taskId,
      );
      // While the run goes on, the end it took still waits, marked with that run.
      yield* notifications.claim(sessionId, "run-x", "task");
      expect(yield* stateOf).toEqual({
        state: "waiting",
        claimed_run_id: "run-x",
        delivered_run_id: null,
      });
      yield* notifications.deliverClaimed(sessionId, "run-x");
      expect(yield* stateOf).toEqual({
        state: "delivered",
        claimed_run_id: null,
        delivered_run_id: "run-x",
      });
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

  it.effect("paged results stay bounded", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
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
    }),
  );

  // A cancel aimed at a subagent's task id once left the Goal run's outcome unknown, though it
  // stopped nothing, and held the next new Goal back.
  it.effect("cancelling a task the session does not own is refused without effect", () =>
    Effect.gen(function* () {
      const sessionId = yield* freshSession;
      const tasks = yield* BackgroundTasks;
      expect(
        yield* Effect.flip(
          callTool(tasks.toolsFor(sessionId), "cancel_background_task", { taskId: "missing" }),
        ),
      ).toMatchObject({ code: "tool_failed", tag: "BackgroundTaskNotFound", refused: true });
    }),
  );
});

// The spy and the completion listener replace parts of the block's agent, so the test owns it.
testAgent()("background result storage failure", (it) => {
  it.effect(
    "an end that cannot be saved reads as failed, without retry or a task left running",
    () =>
      Effect.gen(function* () {
        const { session } = yield* TestEnv;
        const tasks = yield* BackgroundTasks;
        // Each write is counted, then fails; FAIL keeps the count its statement wrote.
        yield* Effect.acquireRelease(
          sqlExec(`CREATE TEMP TABLE result_writes (n INTEGER);
            CREATE TEMP TRIGGER result_write_fails BEFORE UPDATE OF status ON main.background_tasks
            WHEN NEW.status <> 'running'
            BEGIN
              INSERT INTO result_writes VALUES (1);
              SELECT RAISE(FAIL, 'storage offline');
            END;`),
          () =>
            Effect.orDie(
              sqlExec("DROP TRIGGER temp.result_write_fails; DROP TABLE temp.result_writes;"),
            ),
        );
        const notified = yield* Stream.take(tasks.completions, 1).pipe(
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const receipt = yield* tasks.start(
          yield* runOf(session.id),
          `${session.id}:call`,
          "shell",
          "task",
          Effect.succeed("operation completed"),
        );
        const result = yield* tasks.waitResult(session.id, receipt.taskId, 2000);
        expect(result).toMatchObject({ status: "failed" });
        expect(result?.result).toContain("could not be saved");
        expect(yield* readResult(session.id, { taskId: receipt.taskId })).toMatchObject({
          status: "failed",
        });
        expect(yield* sqlGet("SELECT count(*) AS n FROM result_writes")).toEqual({ n: 1 });
        expect(yield* Fiber.join(notified)).toEqual([session.id]);
        expect(yield* tasks.hasSession(session.id)).toBe(false);
      }),
  );
});

// Read-only mode covers the whole database, so this test has a block of its own.
testAgent()("read-only background results", (it) => {
  it.effect("result retrieval neither acknowledges nor consumes a stored result", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const tasks = yield* BackgroundTasks;
      const receipt = yield* tasks.start(
        yield* runOf(session.id),
        `${session.id}:call`,
        "shell",
        "synthetic read-only contract",
        Effect.succeed("saved result"),
      );
      expect(yield* tasks.waitResult(session.id, receipt.taskId, 2000)).toMatchObject({
        status: "completed",
      });
      const changes = yield* sqlGet("SELECT total_changes() AS n");
      yield* Effect.acquireRelease(sqlExec("PRAGMA query_only = ON"), () =>
        Effect.orDie(sqlExec("PRAGMA query_only = OFF")),
      );
      const first = yield* readResult(session.id, { taskId: receipt.taskId });
      expect(first).toMatchObject({ status: "completed", result: "saved result" });
      expect(yield* readResult(session.id, { taskId: receipt.taskId })).toEqual(first);
      expect(yield* Effect.flip(readResult(session.id, { taskId: "missing-task" }))).toMatchObject({
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
        const tools = (yield* ApprovedTools).toolsFor(project, session.id, "gate", run);
        const script = `node -e 'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("finished")}},20)'`;
        yield* callTool(tools, "save_code_skill", {
          name: "wait-release",
          description: "Wait for release",
          program: { runtime: "sh", script },
        });
        const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
          yield* callTool(tools, "run_skill", {
            name: "wait-release",
            yieldMs: 0,
            timeoutSeconds: 5,
          }),
        );
        expect(yield* background.hasSession(session.id)).toBe(true);
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
        expect(yield* Effect.flip(readResult(other, { taskId: receipt.taskId }))).toMatchObject({
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
      expect((yield* tasks.running(session.id)).map((task) => task.id)).toEqual([receipt.taskId]);
      yield* tasks.stopSession(session.id);
      expect(yield* Deferred.isDone(aborted)).toBe(true);
      expect(yield* readResult(session.id, { taskId: receipt.taskId })).toMatchObject({
        status: "cancelled",
      });
      // Simulate a process dying after dispatch with no durable result.
      yield* sqlRun(
        "UPDATE background_tasks SET status = 'running', result = NULL, finished_at = NULL WHERE id = ?",
        receipt.taskId,
      );
      // A process that could not save the end did not put its notification either.
      yield* sqlRun("DELETE FROM orchestrator_notifications WHERE id = ?", receipt.taskId);
      yield* env.reopen;
      expect(yield* (yield* env.use(BackgroundTasks)).hasSession(session.id)).toBe(false);
      expect(yield* env.use(readResult(session.id, { taskId: receipt.taskId }))).toMatchObject({
        status: "interrupted",
      });
      // Its end is told like any other.
      expect(
        yield* env.use(
          Effect.flatMap(OrchestratorNotifications, (notifications) =>
            notifications.wakes(session.id),
          ),
        ),
      ).toBe(true);
      expect(
        yield* sqlGet(
          "SELECT json_extract(payload, '$.status') AS status FROM orchestrator_notifications WHERE id = ?",
          receipt.taskId,
        ),
      ).toEqual({ status: "interrupted" });
    }),
  );
});
