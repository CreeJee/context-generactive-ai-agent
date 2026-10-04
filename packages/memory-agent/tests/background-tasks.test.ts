import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BackgroundTasks } from "../src/tools/background.ts";
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
    const operation = async () => {
      executions++;
      return "done";
    };
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
        (signal) =>
          new Promise((resolve) => {
            started = true;
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve("cancelled");
              },
              { once: true },
            );
          }),
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
        async () => "x".repeat(6000),
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
