import { Effect, Layer } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};
const run = <A>(effect: Effect.Effect<A, never, Database | WorkTraceStore>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(testLayer()))));

const seed = (db: Database["Type"]) => {
  const iso = new Date(0).toISOString();
  db.sqlite
    .prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)")
    .run(iso);
  db.sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(iso);
  db.sqlite
    .prepare(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', NULL, 'running', 'parent-1', 'task', 1, 1)`)
    .run();
};

const start = (trace: WorkTraceStore["Type"]) => {
  const handle = trace.startAttempt({
    sessionId: "s1",
    parentRunId: "parent-1",
    parentToolCallId: "call-1",
    agentId: "agent-1",
    title: "Sensitive research",
    request: "Read a sensitive transcript",
    kind: "start",
    threadId: "subagent-agent-1",
  });
  trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
  return handle;
};

describe("Work Trace task lifecycle", () => {
  test("serializes active archive, waits for cancellation, and restores execution status", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        const requested = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "archive",
          idempotencyKey: "archive-1",
        });
        expect(requested).toMatchObject({ status: "cancelling", operationId: expect.any(String) });
        if (!("operationId" in requested) || !requested.operationId) return;
        expect(trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
          status: "waiting_for_stop",
        });
        trace.checkpoint("s1", {
          handle,
          completedToolCallIds: [],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "Stopped by archive request.",
        });
        trace.transitionAttempt(handle, "s1", "cancelled", "attempt_cancelled", "Cancelled");
        expect(trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
          status: "completed",
          intent: "archive",
        });
        expect(trace.taskTree("s1")[0]?.status).toBe("archived");
        expect(
          db.sqlite
            .prepare(
              "SELECT kind FROM parent_notifications WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
            )
            .get(handle.taskId),
        ).toEqual({ kind: "archived" });
        const restored = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "restore",
          idempotencyKey: "restore-1",
        });
        if (!("operationId" in restored) || !restored.operationId) return;
        expect(trace.finalizeTaskLifecycle(restored.operationId)).toMatchObject({
          status: "completed",
          intent: "restore",
        });
        expect(trace.taskTree("s1")[0]?.status).toBe("cancelled");
      }),
    );
  });

  test("purges task payload once while retaining tombstone, lineage, and immutable receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        trace.recordEvidence({
          handle,
          locator: { kind: "message", threadId: handle.threadId, messageId: "message-1" },
          verification: "verified",
        });
        trace.recordArtifact({
          handle,
          kind: "file",
          locator: {
            kind: "file",
            path: "secret.txt",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          verification: "verified",
        });
        trace.checkpoint("s1", {
          handle,
          transcriptMessageId: "message-1",
          completedToolCallIds: ["tool-1"],
          uncertainToolCallIds: [],
          pendingApprovalIds: [],
          remainingWork: "",
        });
        trace.transitionAttempt(handle, "s1", "completed", "attempt_completed", "Completed");
        const requested = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "delete",
          idempotencyKey: "delete-1",
        });
        const retried = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "delete",
          idempotencyKey: "delete-1",
        });
        if (!("operationId" in requested) || !requested.operationId) return;
        expect(retried).toMatchObject({ operationId: requested.operationId });
        expect(trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
          status: "completed",
          intent: "delete",
          receiptId: expect.any(String),
        });
        expect(trace.taskTree("s1")[0]).toMatchObject({
          status: "deleted",
          title: "Deleted task",
          request: "",
          activeAttemptId: null,
          deletedAt: expect.any(Number),
          purgeReceiptId: expect.any(String),
        });
        expect(trace.evidenceForTask(handle.taskId)[0]).toMatchObject({
          locator: null,
          verification: "source_deleted",
          sourceDeletedAt: expect.any(Number),
        });
        expect(trace.artifactsForTask(handle.taskId)[0]).toMatchObject({
          locator: null,
          verification: "source_deleted",
          sourceDeletedAt: expect.any(Number),
        });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM work_checkpoints WHERE task_id = ?")
            .get(handle.taskId),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM run_events WHERE task_id = ?")
            .get(handle.taskId),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM agent_run_attempts WHERE task_id = ?")
            .get(handle.taskId),
        ).toEqual({ count: 1 });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM purge_receipts WHERE operation_id = ?")
            .get(requested.operationId),
        ).toEqual({ count: 1 });
        const receipt = JSON.stringify(
          db.sqlite
            .prepare("SELECT * FROM purge_receipts WHERE operation_id = ?")
            .get(requested.operationId),
        );
        expect(receipt).not.toContain("Sensitive research");
        expect(receipt).not.toContain("secret.txt");
        expect(
          db.sqlite
            .prepare(
              "SELECT kind FROM parent_notifications WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
            )
            .get(handle.taskId),
        ).toEqual({ kind: "deleted" });
        expect(
          trace.requestResume({
            sessionId: "s1",
            taskId: handle.taskId,
            expectedAttemptId: handle.id,
            confirmUncertain: false,
          }),
        ).toEqual({ status: "blocked", reason: "task_deleted" });
      }),
    );
  });

  test("recovers an unfinished delete idempotently after restart reconciliation", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        trace.transitionAttempt(handle, "s1", "completed", "attempt_completed", "Completed");
        const requested = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "delete",
          idempotencyKey: "crash-delete-1",
        });
        expect(requested.status).toBe("requested");
        trace.recoverLifecycleOperations();
        expect(trace.taskTree("s1")[0]?.status).toBe("deleted");
        trace.recoverLifecycleOperations();
        expect(db.sqlite.prepare("SELECT count(*) AS count FROM purge_receipts").get()).toEqual({
          count: 1,
        });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM parent_notifications WHERE kind = 'deleted'")
            .get(),
        ).toEqual({ count: 1 });
      }),
    );
  });

  test("deletes conversation-owned transcript state after task tombstones while keeping project provenance", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        seed(db);
        const handle = start(trace);
        trace.transitionAttempt(handle, "s1", "completed", "attempt_completed", "Completed");
        db.sqlite
          .prepare(
            `INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
         VALUES ('user-1', 'p1', 's1', 'parent-1', 'user', 'private lifecycle phrase', '{}', ?)`,
          )
          .run(new Date(0).toISOString());
        db.sqlite
          .prepare(
            "INSERT INTO chat_threads (thread_id, messages, updated_at) VALUES ('s1', '[]', 1)",
          )
          .run();
        db.sqlite
          .prepare(
            `INSERT INTO queued_messages
         (id, session_id, seq, text, state, created_at, updated_at)
         VALUES ('queued-1', 's1', 1, 'private queued text', 'waiting', 1, 1)`,
          )
          .run();

        const sessionRequest = trace.requestSessionLifecycle({
          sessionId: "s1",
          intent: "delete",
          idempotencyKey: "delete-session-1",
        });
        if (!("operationId" in sessionRequest) || !sessionRequest.operationId) return;
        expect(trace.finalizeSessionLifecycle(sessionRequest.operationId)).toMatchObject({
          status: "blocked",
          blocker: "task_purge_required",
        });
        const taskRequest = trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "delete",
          idempotencyKey: "delete-session-task-1",
        });
        if (!("operationId" in taskRequest) || !taskRequest.operationId) return;
        trace.finalizeTaskLifecycle(taskRequest.operationId);
        expect(trace.finalizeSessionLifecycle(sessionRequest.operationId)).toMatchObject({
          status: "completed",
          intent: "delete",
        });

        expect(
          db.sqlite.prepare("SELECT count(*) AS count FROM sessions WHERE id = 's1'").get(),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite.prepare("SELECT count(*) AS count FROM nodes WHERE session_id = 's1'").get(),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM queued_messages WHERE session_id = 's1'")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM chat_threads WHERE thread_id = 's1'")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db.sqlite
            .prepare("SELECT origin_session_id FROM work_tasks WHERE id = ?")
            .get(handle.taskId),
        ).toEqual({ origin_session_id: null });
        expect(trace.projectTaskDetail("p1", handle.taskId)?.task.status).toBe("deleted");
        expect(db.sqlite.prepare("SELECT count(*) AS count FROM purge_receipts").get()).toEqual({
          count: 2,
        });
        expect(
          db.sqlite
            .prepare("SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH 'lifecycle'")
            .get(),
        ).toEqual({ count: 0 });
      }),
    );
  });
});
