import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations, taskStatusNotificationsMigration } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

describe("the status changes of Work Trace tasks in the orchestrator's notifications", () => {
  it.effect(
    "its step moves the rows of living conversations, settles what finished runs took and drops the old table",
    () =>
      Effect.gen(function* () {
        const db = yield* database;
        // An app from before the step applied every step before it.
        const index = migrations.indexOf(taskStatusNotificationsMigration);
        migrations.slice(0, index).forEach((step) => db.exec(step));
        const task = (id: string, parentRunId: string, delivery: string) =>
          `('${id}', 'p', 's', '${parentRunId}', 'call-${id}', 'subagent', 'completed', 'T', 'R', '${delivery}', 1, 2)`;
        const change = (row: {
          readonly key: string;
          readonly taskId: string;
          readonly session: string;
          readonly kind: string;
          readonly payload?: string;
          readonly takenBy?: string;
        }) =>
          `('n-${row.key}', 'p', '${row.taskId}', ${row.session},
            (SELECT parent_run_id FROM work_tasks WHERE id = '${row.taskId}'), '${row.kind}', 'S',
            '${row.payload ?? "{}"}', '${row.key}',
            ${row.takenBy === undefined ? "NULL, NULL" : `'${row.takenBy}', 2000`}, 1000)`;
        // A row no run took, one each a completed, a waiting and a failed run took, one of a task
        // the board started, and one whose conversation is gone.
        db.exec(`
          INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
          INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', '2026-01-01');
          INSERT INTO chat_runs (run_id, thread_id, status, started_at)
          VALUES ('run-done', 's', 'completed', 1), ('run-waits', 's', 'interrupted', 1),
            ('run-failed', 's', 'failed', 1);
          INSERT INTO work_tasks
            (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_name,
             status, title, request, delivery, created_at, updated_at)
          VALUES ${task("t-wake", "run-1", "wake")}, ${task("t-board", "kanban:g:S1:1", "next_run")};
          INSERT INTO parent_notifications
            (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
             idempotency_key, delivered_to_run_id, delivered_at, created_at)
          VALUES
            ${change({ key: "k-waiting", taskId: "t-wake", session: "'s'", kind: "completed", payload: '{"attemptId":"a-1"}' })},
            ${change({ key: "k-done", taskId: "t-wake", session: "'s'", kind: "failed", takenBy: "run-done" })},
            ${change({ key: "k-waits", taskId: "t-wake", session: "'s'", kind: "resumed", takenBy: "run-waits" })},
            ${change({ key: "k-failed-run", taskId: "t-wake", session: "'s'", kind: "stopped", takenBy: "run-failed" })},
            ${change({ key: "k-board", taskId: "t-board", session: "'s'", kind: "completed" })},
            ${change({ key: "k-no-session", taskId: "t-wake", session: "NULL", kind: "deleted" })};
        `);

        // Startup runs every step with foreign keys off (migrateDatabase).
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec(taskStatusNotificationsMigration);
        db.exec("PRAGMA foreign_keys = ON");

        const moved = (id: string, delivery: string, deliveredRunId: string | null) => ({
          id,
          session_id: "s",
          sender: "task",
          delivery,
          state: deliveredRunId === null ? "waiting" : "delivered",
          delivered_run_id: deliveredRunId,
        });
        // A row's id is the key that made it unique, not its old id.
        expect(
          db
            .prepare(
              "SELECT id, session_id, sender, delivery, state, delivered_run_id FROM orchestrator_notifications ORDER BY id",
            )
            .all(),
        ).toEqual([
          moved("k-board", "next_run", null),
          moved("k-done", "wake", "run-done"),
          moved("k-failed-run", "wake", null),
          moved("k-waiting", "wake", null),
          moved("k-waits", "wake", "run-waits"),
        ]);
        expect(
          db
            .prepare(
              `SELECT json_extract(payload, '$._tag') AS tag,
                 json_extract(payload, '$.taskId') AS task_id,
                 json_extract(payload, '$.parentRunId') AS parent_run_id,
                 json_extract(payload, '$.kind') AS kind,
                 json_extract(payload, '$.detail.attemptId') AS attempt_id, created_at
               FROM orchestrator_notifications WHERE id = 'k-waiting'`,
            )
            .get(),
        ).toEqual({
          tag: "TaskStatus",
          task_id: "t-wake",
          parent_run_id: "run-1",
          kind: "completed",
          attempt_id: "a-1",
          created_at: "1970-01-01T00:00:01.000Z",
        });
        expect(
          db
            .prepare("SELECT delivered_at FROM orchestrator_notifications WHERE id = 'k-done'")
            .get(),
        ).toEqual({ delivered_at: "1970-01-01T00:00:02.000Z" });
        // The old table and its two indexes are gone.
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'parent_notifications%'")
            .all(),
        ).toEqual([]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }),
  );
});
