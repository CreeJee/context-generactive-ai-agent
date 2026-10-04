import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cause, Deferred, Effect, Schema } from "effect";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  BackgroundTasks,
  BackgroundOperationFailed,
  BackgroundResultStoreFailed,
} from "../src/tools/background.ts";
import { ApprovedTools } from "../src/tools/approved.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

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

describe("background task lifecycle", () => {
  test("simultaneous replay dispatches only one operation", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const binding = {
      sessionId: session.id,
      runId: randomUUID(),
      abortSignal: new AbortController().signal,
    };
    const callId = randomUUID();
    let executions = 0;
    const operation = Effect.sync(() => {
      executions++;
      return "done";
    });
    const receipts = await runtime.runPromise(
      Effect.all(
        [
          tasks.start(binding, callId, "shell", "task", operation),
          tasks.start(binding, callId, "shell", "task", operation),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(receipts[0]?.taskId).toBe(receipts[1]?.taskId);
    await runtime.runPromise(tasks.waitResult(session.id, receipts[0]!.taskId, 2000));
    expect(executions).toBe(1);
  });
  test("malformed persisted results fail in the typed storage channel", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const receipt = await runtime.runPromise(
      tasks.start(
        { sessionId: session.id, runId: randomUUID(), abortSignal: new AbortController().signal },
        randomUUID(),
        "shell",
        "task",
        Effect.succeed("done"),
      ),
    );
    await runtime.runPromise(tasks.waitResult(session.id, receipt.taskId, 2000));
    const state = await runtime.runPromise(ChatState);
    await state.persistence.stores.metadata.set("background-task-result", receipt.taskId, {
      status: "completed",
    });
    const exit = await runtime.runPromise(
      Effect.exit(tasks.waitResult(session.id, receipt.taskId, 0)),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected storage failure");
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(Cause.squash(exit.cause)).toBeInstanceOf(BackgroundResultStoreFailed);
  });
  test("operation failure is stored once and finalizes the attempt as failed", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const receipt = await runtime.runPromise(
      tasks.start(
        { sessionId: session.id, runId: randomUUID(), abortSignal: new AbortController().signal },
        randomUUID(),
        "shell",
        "failing task",
        Effect.fail(new BackgroundOperationFailed({ cause: new Error("execution failed") })),
      ),
    );
    const result = await runtime.runPromise(tasks.waitResult(session.id, receipt.taskId, 2000));
    expect(result).toMatchObject({ status: "failed" });
    expect(result?.result).toContain("execution failed");
    const trace = await runtime.runPromise(WorkTraceStore);
    expect(trace.taskDetail(session.id, receipt.taskId)?.task.status).toBe("failed");
  });
  test("persistent result write failure records a terminal failure without retry or false completion", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const state = await runtime.runPromise(ChatState);
    const original = state.persistence.stores.metadata.set.bind(state.persistence.stores.metadata);
    let resultWrites = 0;
    const spy = vi
      .spyOn(state.persistence.stores.metadata, "set")
      .mockImplementation((namespace, key, value) => {
        if (namespace === "background-task-result") {
          resultWrites++;
          return Promise.reject(new Error("storage offline"));
        }
        return original(namespace, key, value);
      });
    let notifications = 0;
    tasks.onCompletion(() => {
      notifications++;
    });
    try {
      const receipt = await runtime.runPromise(
        tasks.start(
          { sessionId: session.id, runId: randomUUID(), abortSignal: new AbortController().signal },
          randomUUID(),
          "shell",
          "task",
          Effect.succeed("operation completed"),
        ),
      );
      const result = await runtime.runPromise(tasks.waitResult(session.id, receipt.taskId, 2000));
      expect(result).toMatchObject({ status: "failed" });
      expect(result?.result).toContain("background_result_storage_failed");
      const trace = await runtime.runPromise(WorkTraceStore);
      expect(trace.taskDetail(session.id, receipt.taskId)?.task.status).toBe("failed");
      expect(
        await tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId }),
      ).toMatchObject({ status: "failed" });
      expect(resultWrites).toBe(1);
      expect(notifications).toBe(1);
      expect(tasks.hasSession(session.id)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  test("parent interruption awaits the operation finalizer before recording cancellation", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const gate = Deferred.makeUnsafe<void>();
    let started = false;
    let cleaning = false;
    const controller = new AbortController();
    const receipt = await runtime.runPromise(
      tasks.start(
        { sessionId: session.id, runId: randomUUID(), abortSignal: controller.signal },
        randomUUID(),
        "external_agent",
        "task",
        Effect.sync(() => {
          started = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaning = true;
            }).pipe(Effect.andThen(Deferred.await(gate))),
          ),
        ),
      ),
    );
    await expect.poll(() => started).toBe(true);
    controller.abort();
    await expect.poll(() => cleaning).toBe(true);
    expect(
      await tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId }),
    ).toMatchObject({ status: "running" });
    await runtime.runPromise(Deferred.succeed(gate, undefined));
    expect(
      await runtime.runPromise(tasks.waitResult(session.id, receipt.taskId, 2000)),
    ).toMatchObject({ status: "cancelled" });
  });
  test("replayed tool calls retrieve the original operation without repeating effects", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const binding = {
      sessionId: session.id,
      runId: randomUUID(),
      abortSignal: new AbortController().signal,
    };
    const callId = randomUUID();
    let executions = 0;
    const operation = Effect.sync(() => {
      executions++;
      return "done";
    });
    const first = await runtime.runPromise(
      tasks.start(binding, callId, "shell", "task", operation),
    );
    await runtime.runPromise(tasks.waitResult(session.id, first.taskId, 2000));
    const replay = await runtime.runPromise(
      tasks.start(binding, callId, "shell", "task", operation),
    );
    expect(replay).toMatchObject({
      taskId: first.taskId,
      attemptId: first.attemptId,
      status: "completed",
    });
    expect(executions).toBe(1);
  });
  test("shell yields before completion, survives parent end, and results remain scoped and durable", async () => {
    const { runtime, project, session, reopen } = await testRuntime();
    const background = await runtime.runPromise(BackgroundTasks);
    const approved = await runtime.runPromise(ApprovedTools);
    const controller = new AbortController();
    const [shell] = approved.forProject(project, "gate", {
      sessionId: session.id,
      runId: randomUUID(),
      abortSignal: controller.signal,
    });
    const command = `node -e 'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("finished")}},20)'`;
    const receipt = Schema.decodeUnknownSync(Receipt)(
      await shell.execute!(
        { command, yieldMs: 0, timeoutSeconds: 5 },
        {
          toolCallId: randomUUID(),
          abortSignal: controller.signal,
          emitCustomEvent: () => undefined,
        },
      ),
    );
    expect(background.hasSession(session.id)).toBe(true);
    const resultTool = background.forSession(session.id)[0]!;
    expect(await resultTool.execute!({ taskId: receipt.taskId })).toMatchObject({
      status: "running",
    });
    // Independent parent work unlocks the real child process. No wall-clock assertion.
    writeFileSync(join(project.root, "release"), "done");
    const finished = await runtime.runPromise(
      background.waitResult(session.id, receipt.taskId, 4000),
    );
    expect(finished?.result).toContain("finished");
    const page = Schema.decodeUnknownSync(Page)(
      await resultTool.execute!({ taskId: receipt.taskId }),
    );
    expect(page.status).toBe("completed");
    const other = await runtime.runPromise(
      Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
    );
    await expect(
      background.forSession(other.id)[0]!.execute!({ taskId: receipt.taskId }),
    ).rejects.toThrow("not found");
    const next = await reopen();
    expect(
      await (await next.runPromise(BackgroundTasks)).forSession(session.id)[0]!.execute!({
        taskId: receipt.taskId,
      }),
    ).toMatchObject(page);
  });
  test("cancel stops active work and restart never resends an interrupted operation", async () => {
    const { runtime, session, reopen } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    let started = false;
    let aborted = false;
    const receipt = await runtime.runPromise(
      tasks.start(
        { sessionId: session.id, runId: randomUUID(), abortSignal: new AbortController().signal },
        randomUUID(),
        "external_agent",
        "synthetic task",
        Effect.sync(() => {
          started = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              aborted = true;
            }),
          ),
        ),
      ),
    );
    await expect.poll(() => started).toBe(true);
    await runtime.runPromise(tasks.stopSession(session.id));
    expect(aborted).toBe(true);
    expect(
      await tasks.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId }),
    ).toMatchObject({ status: "cancelled" });
    // Simulate a process dying after dispatch with no durable result.
    const state = await runtime.runPromise(ChatState);
    await state.persistence.stores.metadata.delete("background-task-result", receipt.taskId);
    const db = await runtime.runPromise(Database);
    db.sqlite
      .prepare("UPDATE agent_run_attempts SET status='running' WHERE id=?")
      .run(receipt.attemptId);
    db.sqlite
      .prepare("UPDATE work_tasks SET active_attempt_id=?,status='running' WHERE id=?")
      .run(receipt.attemptId, receipt.taskId);
    const next = await reopen();
    const reopened = await next.runPromise(BackgroundTasks);
    expect(reopened.hasSession(session.id)).toBe(false);
    expect(
      await reopened.forSession(session.id)[0]!.execute!({ taskId: receipt.taskId }),
    ).toMatchObject({ status: "interrupted" });
  });
  test("paged results stay bounded and task deletion clears their stored payload", async () => {
    const { runtime, session } = await testRuntime();
    const tasks = await runtime.runPromise(BackgroundTasks);
    const receipt = await runtime.runPromise(
      tasks.start(
        { sessionId: session.id, runId: randomUUID(), abortSignal: new AbortController().signal },
        randomUUID(),
        "external_agent",
        "task",
        Effect.succeed("x".repeat(6000)),
      ),
    );
    await runtime.runPromise(tasks.waitResult(session.id, receipt.taskId, 2000));
    const tool = tasks.forSession(session.id)[0]!;
    expect(await tool.execute!({ taskId: receipt.taskId })).toMatchObject({
      result: "x".repeat(4000),
      nextOffset: 4000,
    });
    expect(await tool.execute!({ taskId: receipt.taskId, offset: 4000 })).toMatchObject({
      result: "x".repeat(2000),
      nextOffset: null,
    });
    const trace = await runtime.runPromise(WorkTraceStore);
    const requested = trace.requestTaskLifecycle({
      sessionId: session.id,
      taskId: receipt.taskId,
      intent: "delete",
      idempotencyKey: randomUUID(),
    });
    expect(requested.status).toBe("requested");
    if (requested.status !== "requested") throw new Error("delete not requested");
    expect(trace.finalizeTaskLifecycle(requested.operationId).status).toBe("completed");
    expect(
      await (
        await runtime.runPromise(ChatState)
      ).persistence.stores.metadata.get("background-task-result", receipt.taskId),
    ).toBeNull();
    await expect(tool.execute!({ taskId: receipt.taskId })).rejects.toThrow("not found");
  });
});
