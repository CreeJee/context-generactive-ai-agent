import { SqlClient } from "effect/sql";
import { DateTime, Schema, Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../src/db/database.ts";
import { ArtifactLocator } from "../src/work-trace/contracts.ts";
import {
  LifecycleOutcome,
  LifecycleRequest,
  ResumeRequest,
  WorkTraceStore,
} from "../src/work-trace/store.ts";
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

/** The operation a request recorded and still has to finish; null when it needs none. */
const pendingOperationId = LifecycleRequest.$match({
  requested: ({ operationId }) => operationId,
  cancelling: ({ operationId }) => operationId,
  waiting_for_stop: ({ operationId }) => operationId,
  purging: ({ operationId }) => operationId,
  failed: ({ operationId }) => operationId,
  completed: () => null,
  blocked: () => null,
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

/** What a conversation's Goal run leaves: catalog, owner receipts, worker pins, board and queue. */
const goalHistory = Effect.fnUntraced(function* (sessionId: string, goalId: string, runId: string) {
  const executionId = `execution-${runId}`;
  yield* sqlRun("INSERT INTO workflow_goal_identities VALUES (?, ?, 'now')", sessionId, goalId);
  const { lastInsertRowid: revision } = yield* sqlRun(
    `INSERT INTO workflow_state_revisions
       (session_id, state_json, goal_version, provenance, created_at, goal_instance_id)
     VALUES (?, '{}', 1, 'recorded', 'now', ?)`,
    sessionId,
    goalId,
  );
  yield* sqlRun(
    "INSERT INTO workflow_run_bindings VALUES (?, ?, ?, 1, NULL, ?, 'now')",
    runId,
    sessionId,
    goalId,
    revision,
  );
  yield* sqlRun(
    `INSERT INTO owner_workflow_executions (execution_id, workflow_name, payload_json, status)
     VALUES (?, 'GoalExecution', json_object('identity', json_object('sessionId', ?)), 'suspended')`,
    executionId,
    sessionId,
  );
  yield* sqlRun(
    `INSERT INTO owner_rpc_operations
       (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
     VALUES (?, 'key', 1, '{}', 1, '{}', 'succeeded')`,
    runId,
  );
  yield* sqlRun(
    `INSERT INTO owner_read_recoveries
       (receipt_id, run_id, session_id, goal_instance_id, workflow_revision_id, operation_id,
        operation_fingerprint, authorization_fingerprint, run_key, finished_at, execution_id,
        execution_result_json, execution_payload_json, assessment_id, policy, confirmation,
        backup_reference, created_at)
     VALUES (?, ?, ?, ?, ?, 1, '{}', '{}', 'key', 1, ?, '{}', '{}', ?,
       'background-result-read-v1', 'confirm_read_only_and_continue_without_replay', 'backup', 1)`,
    `receipt-${runId}`,
    runId,
    sessionId,
    goalId,
    revision,
    executionId,
    "0".repeat(64),
  );
  yield* sqlRun(
    "INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, 'file:///worker.mjs', 'now')",
    goalId,
    `generation-${goalId}`,
    "0".repeat(64),
  );
  yield* sqlRun(
    "INSERT INTO workflow_goal_native_artifacts VALUES (?, 'file:///native.mjs', 'hash', 'v1', 'source', 'now')",
    goalId,
  );
  yield* sqlRun(
    `INSERT INTO kanban_goals (goal_instance_id, session_id, project_id, project_root, mode,
       goal_version, status, created_at, updated_at)
     VALUES (?, ?, 'p1', '/tmp/p1', 'sequential', 1, 'stopped', 1, 1)`,
    goalId,
    sessionId,
  );
  yield* sqlRun(
    "INSERT INTO kanban_cards (goal_instance_id, card_id) VALUES (?, 'card-1')",
    goalId,
  );
  yield* sqlRun(
    `INSERT INTO persisted_queue_items
       (queue_name, id, element_json, state, visible_at, created_at, updated_at)
     VALUES ('DurableQueue/KanbanCard', ?, json_object('payload', json_object('sessionId', ?)),
       'completed', 0, 0, 0)`,
    `item-${goalId}`,
    sessionId,
  );
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
          expect(LifecycleRequest.$is("cancelling")(requested)).toBe(true);
          if (!LifecycleRequest.$is("cancelling")(requested)) return;
          expect(
            LifecycleOutcome.$is("waiting_for_stop")(
              yield* trace.finalizeTaskLifecycle(requested.operationId),
            ),
          ).toBe(true);
          yield* trace.transitionAttempt(
            handle,
            "s1",
            "cancelled",
            "attempt_cancelled",
            "Cancelled",
          );
          const archived = yield* trace.finalizeTaskLifecycle(requested.operationId);
          expect(LifecycleOutcome.$is("completed")(archived) && archived.intent).toBe("archive");
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
          const restoredId = pendingOperationId(restored);
          if (restoredId === null) return;
          const restoredOutcome = yield* trace.finalizeTaskLifecycle(restoredId);
          expect(LifecycleOutcome.$is("completed")(restoredOutcome) && restoredOutcome.intent).toBe(
            "restore",
          );
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
            locator: ArtifactLocator.cases.file.make({
              path: "secret.txt",
              sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
            mediaType: "text/plain",
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
          const operationId = pendingOperationId(requested);
          if (operationId === null) return;
          expect(retried).toMatchObject({ operationId });
          const deleted = yield* trace.finalizeTaskLifecycle(operationId);
          expect(LifecycleOutcome.$is("completed")(deleted)).toBe(true);
          expect(deleted).toMatchObject({ intent: "delete", receiptId: expect.any(String) });
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
            mediaType: null,
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
              operationId,
            ),
          ).toEqual({ count: 1 });
          const receipt = yield* stringifyJson(
            yield* sqlGet("SELECT * FROM purge_receipts WHERE operation_id = ?", operationId),
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
          ).toEqual(ResumeRequest.blocked({ reason: "task_deleted" }));
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
        expect(LifecycleRequest.$is("requested")(requested)).toBe(true);
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
          // Another conversation's node, linked to this one and imported like it, stays.
          yield* sqlRun(
            "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s2', 'p1', NULL, ?)",
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          yield* sqlRun(
            `INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
         VALUES ('other-1', 'p1', 's2', 'parent-2', 'user', 'other conversation', '{}', ?)`,
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          yield* sqlRun(
            `INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
         VALUES ('other-1', 'user-1', 'related', 'llm', 1, ?)`,
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          yield* sqlRun(
            `INSERT INTO imported_nodes (source, external_id, node_id)
         VALUES ('codex', 'line-1', 'user-1'), ('codex', 'line-2', 'other-1')`,
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
          const sessionOperationId = pendingOperationId(sessionRequest);
          if (sessionOperationId === null) return;
          expect(yield* trace.finalizeSessionLifecycle(sessionOperationId)).toEqual(
            LifecycleOutcome.blocked({
              blocker: "task_purge_required",
              operationId: sessionOperationId,
            }),
          );
          const taskRequest = yield* trace.requestTaskLifecycle({
            sessionId: "s1",
            taskId: handle.taskId,
            intent: "delete",
            idempotencyKey: "delete-session-task-1",
          });
          const taskOperationId = pendingOperationId(taskRequest);
          if (taskOperationId === null) return;
          yield* trace.finalizeTaskLifecycle(taskOperationId);
          const sessionDeleted = yield* trace.finalizeSessionLifecycle(sessionOperationId);
          expect(LifecycleOutcome.$is("completed")(sessionDeleted) && sessionDeleted.intent).toBe(
            "delete",
          );

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
          expect(yield* sqlGet("SELECT count(*) AS count FROM edges")).toEqual({ count: 0 });
          expect(yield* sqlGet("SELECT group_concat(node_id) AS ids FROM imported_nodes")).toEqual({
            ids: "other-1",
          });
          expect(
            yield* sqlGet(
              "SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH 'conversation'",
            ),
          ).toEqual({ count: 1 });
        }),
      ),
  );

  it.effect("deletes a conversation's Goal history with it and keeps another's immutable", () =>
    run(
      Effect.gen(function* () {
        const trace = yield* WorkTraceStore;
        yield* seed();
        yield* sqlRun(
          "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s2', 'p1', NULL, 'now')",
        );
        yield* Effect.forEach(["1", "2"], (n) => goalHistory(`s${n}`, `goal-${n}`, `run-${n}`), {
          discard: true,
        });
        // s1's Goal waits for s2's; the wait goes with s1.
        yield* sqlRun(`INSERT INTO kanban_goal_dependencies (goal_instance_id, depends_on, created_at)
          VALUES ('goal-1', 'goal-2', 1)`);

        const requested = yield* trace.requestSessionLifecycle({
          sessionId: "s1",
          intent: "delete",
          idempotencyKey: "delete-session-1",
        });
        const operationId = pendingOperationId(requested);
        if (operationId === null) return;
        expect(
          LifecycleOutcome.$is("completed")(yield* trace.finalizeSessionLifecycle(operationId)),
        ).toBe(true);

        // Only s2's rows are left.
        expect(
          yield* sqlGet(`SELECT
            (SELECT count(*) FROM workflow_goal_instances) AS goals,
            (SELECT count(*) FROM workflow_run_bindings) AS bindings,
            (SELECT count(*) FROM owner_rpc_operations) AS receipts,
            (SELECT count(*) FROM owner_read_recoveries) AS recoveries,
            (SELECT count(*) FROM workflow_goal_worker_generations) AS generations,
            (SELECT count(*) FROM workflow_goal_native_artifacts) AS natives,
            (SELECT count(*) FROM owner_workflow_executions) AS executions,
            (SELECT count(*) FROM kanban_goals) AS boards,
            (SELECT count(*) FROM kanban_cards) AS cards,
            (SELECT count(*) FROM kanban_goal_dependencies) AS dependencies,
            (SELECT count(*) FROM persisted_queue_items) AS items,
            (SELECT count(*) FROM goal_history_purges) AS permits`),
        ).toEqual({
          goals: 1,
          bindings: 1,
          receipts: 1,
          recoveries: 1,
          generations: 1,
          natives: 1,
          executions: 1,
          boards: 1,
          cards: 1,
          dependencies: 0,
          items: 1,
          permits: 0,
        });
        expect(
          yield* sqlGet("SELECT group_concat(goal_instance_id) AS ids FROM kanban_goals"),
        ).toEqual({ ids: "goal-2" });
        expect(
          yield* sqlGet(
            "SELECT json_extract(purged_counts, '$.goals') AS goals FROM purge_receipts WHERE target_id = 's1'",
          ),
        ).toEqual({ goals: 1 });
        const refused = yield* Effect.flip(
          sqlRun("DELETE FROM workflow_goal_instances WHERE goal_instance_id = 'goal-2'"),
        );
        expect(String(refused.reason.cause)).toContain("goal instance is immutable");
      }),
    ),
  );

  it.effect(
    "keeps a conversation another running board waits for, and blocks an earlier delete",
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
          // Recorded before s2's board came to wait for s1's Goal.
          const earlier = yield* trace.requestSessionLifecycle({
            sessionId: "s1",
            intent: "delete",
            idempotencyKey: "delete-session-1",
          });
          const operationId = pendingOperationId(earlier);
          if (operationId === null) return;
          expect(yield* trace.pendingSessionDeletes).toEqual(["s1"]);
          yield* sqlRun(
            "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s2', 'p1', NULL, 'now')",
          );
          yield* sqlRun("INSERT INTO workflow_goal_identities VALUES ('s1', 'goal-1', 'now')");
          yield* sqlRun("INSERT INTO workflow_goal_identities VALUES ('s2', 'goal-2', 'now')");
          yield* sqlRun(`INSERT INTO kanban_goals (goal_instance_id, session_id, project_id,
            project_root, mode, goal_version, status, created_at, updated_at)
          VALUES ('goal-2', 's2', 'p1', '/tmp/p1', 'sequential', 1, 'active', 1, 1)`);
          yield* sqlRun(`INSERT INTO kanban_goal_dependencies (goal_instance_id, depends_on, created_at)
          VALUES ('goal-2', 'goal-1', 1)`);

          yield* trace.recoverLifecycleOperations();
          expect(
            yield* sqlGet(
              "SELECT status, blocker FROM lifecycle_operations WHERE id = ?",
              operationId,
            ),
          ).toEqual({ status: "blocked", blocker: "goal_dependents" });
          // Startup leaves its board running while the delete stays blocked.
          expect(yield* trace.pendingSessionDeletes).toEqual([]);
          expect(yield* sqlGet("SELECT count(*) AS count FROM sessions WHERE id = 's1'")).toEqual({
            count: 1,
          });
          expect(
            yield* sqlGet("SELECT deleted_at FROM work_tasks WHERE id = ?", handle.taskId),
          ).toEqual({ deleted_at: null });
          expect(
            yield* trace.requestSessionLifecycle({
              sessionId: "s1",
              intent: "delete",
              idempotencyKey: "delete-session-2",
            }),
          ).toEqual(LifecycleRequest.blocked({ blocker: "goal_dependents" }));
        }),
      ),
  );
});
