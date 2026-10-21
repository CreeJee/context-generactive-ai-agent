import { isTruthy } from "../src/truthy.ts";
import { SqlClient } from "effect/sql";
import { DateTime, Schema, Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { sqlGet, sqlRun } from "./support/sql.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = () => {
  const database = Database.layer(":memory:");
  return Layer.merge(database, WorkTraceStore.layer.pipe(Layer.provide(database)));
};
const run = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | WorkTraceStore>,
) {
  const services = yield* Layer.build(testLayer());
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);

const seed = Effect.fnUntraced(function* () {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(0));
  yield* sqlRun(
    "INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/p1', 'p1', ?)",
    iso,
  );
  yield* sqlRun(
    "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    iso,
  );
  yield* sqlRun(`INSERT INTO subagents
    (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
    VALUES ('agent-1', 's1', 'researcher', NULL, 'running', 'parent-1', 'task', 1, 1)`);
});

const start = Effect.fnUntraced(function* (trace: WorkTraceStore["Service"]) {
  const handle = yield* trace.startAttempt({
    sessionId: "s1",
    parentRunId: "parent-1",
    parentToolCallId: "call-1",
    agentId: "agent-1",
    title: "Sensitive research",
    request: "Read a sensitive transcript",
    kind: "start",
    threadId: "subagent-agent-1",
  });
  yield* trace.transitionAttempt(handle, "s1", "running", "attempt_started", "Started");
  return handle;
});

describe("Work Trace task lifecycle", () => {
  it.effect(
    "serializes active archive, waits for cancellation, and restores execution status",
    () =>
      run(
        Effect.gen(function* () {
          const trace = yield* WorkTraceStore;
          yield* seed();
          const handle = yield* start(trace);
          const requested = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "archive",
            idempotencyKey: "archive-1",
          });
          expect(requested).toMatchObject({
            status: "cancelling",
            operationId: expect.any(String),
          });
          if (!("operationId" in requested) || !isTruthy(requested.operationId)) return;
          expect(yield* trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
            status: "waiting_for_stop",
          });
          yield* trace.transitionAttempt(
            handle,
            "s1",
            "cancelled",
            "attempt_cancelled",
            "Cancelled",
          );
          expect(yield* trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
            status: "completed",
            intent: "archive",
          });
          expect((yield* trace.taskTree("s1"))[0]?.status).toBe("archived");
          expect(
            yield* sqlGet(
              "SELECT kind FROM parent_notifications WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
              handle.taskId,
            ),
          ).toEqual({ kind: "archived" });
          const restored = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "restore",
            idempotencyKey: "restore-1",
          });
          if (!("operationId" in restored) || !isTruthy(restored.operationId)) return;
          expect(yield* trace.finalizeTaskLifecycle(restored.operationId)).toMatchObject({
            status: "completed",
            intent: "restore",
          });
          expect((yield* trace.taskTree("s1"))[0]?.status).toBe("cancelled");
        }),
      ),
  );

  it.effect(
    "purges task payload once while retaining tombstone, lineage, and immutable receipt",
    () =>
      run(
        Effect.gen(function* () {
          const trace = yield* WorkTraceStore;
          yield* seed();
          const handle = yield* start(trace);
          yield* trace.recordArtifact({
            handle,
            kind: "file",
            locator: {
              kind: "file",
              path: "secret.txt",
              sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            verification: "verified",
          });
          yield* trace.transitionAttempt(
            handle,
            "s1",
            "completed",
            "attempt_completed",
            "Completed",
          );
          const requested = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "delete",
            idempotencyKey: "delete-1",
          });
          const retried = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "delete",
            idempotencyKey: "delete-1",
          });
          if (!("operationId" in requested) || !isTruthy(requested.operationId)) return;
          expect(retried).toMatchObject({ operationId: requested.operationId });
          expect(yield* trace.finalizeTaskLifecycle(requested.operationId)).toMatchObject({
            status: "completed",
            intent: "delete",
            receiptId: expect.any(String),
          });
          expect((yield* trace.taskTree("s1"))[0]).toMatchObject({
            status: "deleted",
            title: "Deleted task",
            request: "",
            activeAttemptId: null,
            deletedAt: expect.any(Number),
            purgeReceiptId: expect.any(String),
          });
          expect((yield* trace.artifactsForTask(handle.taskId))[0]).toMatchObject({
            locator: null,
            verification: "source_deleted",
            sourceDeletedAt: expect.any(Number),
          });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM run_events WHERE task_id = ?",
              handle.taskId,
            ),
          ).toEqual({ count: 0 });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM agent_run_attempts WHERE task_id = ?",
              handle.taskId,
            ),
          ).toEqual({ count: 1 });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM purge_receipts WHERE operation_id = ?",
              requested.operationId,
            ),
          ).toEqual({ count: 1 });
          const receipt = yield* stringifyJson(
            yield* sqlGet(
              "SELECT * FROM purge_receipts WHERE operation_id = ?",
              requested.operationId,
            ),
          );
          expect(receipt).not.toContain("Sensitive research");
          expect(receipt).not.toContain("secret.txt");
          expect(
            yield* sqlGet(
              "SELECT kind FROM parent_notifications WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
              handle.taskId,
            ),
          ).toEqual({ kind: "deleted" });
          expect(
            yield* trace.requestResume({
              sessionId: "s1",
              taskId: handle.taskId,
              expectedAttemptId: handle.id,
              confirmUncertain: false,
            }),
          ).toEqual({ status: "blocked", reason: "task_deleted" });
        }),
      ),
  );

  it.effect("recovers an unfinished delete idempotently after restart reconciliation", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        const handle = yield* start(trace);
        yield* trace.transitionAttempt(handle, "s1", "completed", "attempt_completed", "Completed");
        const requested = yield* trace.requestTaskLifecycle({
          sessionId: "s1",
          taskId: handle.taskId,
          intent: "delete",
          idempotencyKey: "crash-delete-1",
        });
        expect(requested.status).toBe("requested");
        yield* trace.recoverLifecycleOperations();
        expect((yield* trace.taskTree("s1"))[0]?.status).toBe("deleted");
        yield* trace.recoverLifecycleOperations();
        expect(yield* sqlGet("SELECT count(*) AS count FROM purge_receipts")).toEqual({
          count: 1,
        });
        expect(
          yield* sqlGet(
            "SELECT count(*) AS count FROM parent_notifications WHERE kind = 'deleted'",
          ),
        ).toEqual({ count: 1 });
      }),
    ),
  );

  it.effect(
    "deletes conversation-owned transcript state after task tombstones while keeping project provenance",
    () =>
      run(
        Effect.gen(function* () {
          const trace = yield* WorkTraceStore;
          yield* seed();
          const handle = yield* start(trace);
          yield* trace.transitionAttempt(
            handle,
            "s1",
            "completed",
            "attempt_completed",
            "Completed",
          );
          yield* sqlRun(
            `INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
         VALUES ('user-1', 'p1', 's1', 'parent-1', 'user', 'private lifecycle phrase', '{}', ?)`,
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          yield* sqlRun(
            "INSERT INTO nodes_morph (rowid, terms) SELECT seq, 'private lifecycle' FROM nodes WHERE id = 'user-1'",
          );
          yield* sqlRun(
            "INSERT INTO chat_threads (thread_id, messages, updated_at) VALUES ('s1', '[]', 1)",
          );
          yield* sqlRun(
            `INSERT INTO queued_messages
         (id, session_id, seq, text, state, created_at, updated_at)
         VALUES ('queued-1', 's1', 1, 'private queued text', 'waiting', 1, 1)`,
          );

          const sessionRequest = yield* trace.requestSessionLifecycle({
            sessionId: "s1",
            intent: "delete",
            idempotencyKey: "delete-session-1",
          });
          if (!("operationId" in sessionRequest) || !isTruthy(sessionRequest.operationId)) return;
          expect(yield* trace.finalizeSessionLifecycle(sessionRequest.operationId)).toMatchObject({
            status: "blocked",
            blocker: "task_purge_required",
          });
          const taskRequest = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "delete",
            idempotencyKey: "delete-session-task-1",
          });
          if (!("operationId" in taskRequest) || !isTruthy(taskRequest.operationId)) return;
          yield* trace.finalizeTaskLifecycle(taskRequest.operationId);
          expect(yield* trace.finalizeSessionLifecycle(sessionRequest.operationId)).toMatchObject({
            status: "completed",
            intent: "delete",
          });

          expect(yield* sqlGet("SELECT count(*) AS count FROM sessions WHERE id = 's1'")).toEqual({
            count: 0,
          });
          expect(
            yield* sqlGet("SELECT count(*) AS count FROM nodes WHERE session_id = 's1'"),
          ).toEqual({ count: 0 });
          expect(
            yield* sqlGet("SELECT count(*) AS count FROM queued_messages WHERE session_id = 's1'"),
          ).toEqual({ count: 0 });
          expect(
            yield* sqlGet("SELECT count(*) AS count FROM chat_threads WHERE thread_id = 's1'"),
          ).toEqual({ count: 0 });
          expect(
            yield* sqlGet("SELECT origin_session_id FROM work_tasks WHERE id = ?", handle.taskId),
          ).toEqual({ origin_session_id: null });
          expect((yield* trace.projectTaskDetail("p1", handle.taskId))?.task.status).toBe(
            "deleted",
          );
          expect(yield* sqlGet("SELECT count(*) AS count FROM purge_receipts")).toEqual({
            count: 2,
          });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH 'lifecycle'",
            ),
          ).toEqual({ count: 0 });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM nodes_morph WHERE nodes_morph MATCH 'lifecycle'",
            ),
          ).toEqual({ count: 0 });
        }),
      ),
  );
});
