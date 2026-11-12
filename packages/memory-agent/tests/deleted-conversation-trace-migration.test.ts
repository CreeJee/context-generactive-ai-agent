import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { deletedConversationTraceMigration, migrations } from "../src/db/migrations.ts";

it.effect("the Work Trace a deleted conversation left goes; its own receipt stays", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(deletedConversationTraceMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    const task = (id: string, session: string) =>
      `('${id}', 'p', ${session}, 'run', 'call-${id}', 'subagent', 'completed', 'T ${id}', 'R', 1, 2)`;
    const operation = (id: string, kind: string, target: string) =>
      `('${id}', 'p', '${kind}', '${target}', 'delete', 'completed', '${id}', 1, 1)`;
    const receipt = (id: string, kind: string, target: string) =>
      `('receipt-${id}', '${id}', 'p', '${kind}', '${target}', 1, '{}', '[]', 1)`;
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO work_tasks
        (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_name, status,
         title, request, created_at, updated_at)
        VALUES ${task("kept", "'s'")}, ${task("left", "NULL")};
      INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message, idempotency_key,
         created_at)
        SELECT 'i-' || id, id, 'run', 'call-' || id, 'start', 'completed', 'R', 'key-' || id, 1
        FROM work_tasks;
      INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status, created_at,
         updated_at)
        SELECT 'a-' || id, id, 'i-' || id, 1, 'run-' || id, 'subagent-' || id, 'completed', 1, 2
        FROM work_tasks;
      INSERT INTO parent_notifications
        (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
         idempotency_key, created_at)
        VALUES ('n-left', 'p', 'left', NULL, 'run', 'deleted', 'Subagent task deleted', '{}',
          'n-left', 1);
      -- The task's own deletion, then its conversation's.
      INSERT INTO lifecycle_operations
        (id, project_id, target_kind, target_id, intent, status, idempotency_key, requested_at,
         updated_at)
        VALUES ${operation("op-left", "task", "left")}, ${operation("op-gone", "session", "gone")};
      INSERT INTO purge_receipts
        (id, operation_id, project_id, target_kind, target_id, policy_version, purged_counts,
         retained_kinds, completed_at)
        VALUES ${receipt("op-left", "task", "left")}, ${receipt("op-gone", "session", "gone")};
      UPDATE work_tasks SET purge_receipt_id = 'receipt-op-left', deleted_at = 1 WHERE id = 'left';
    `);

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT id FROM work_tasks").all()).toEqual([{ id: "kept" }]);
    expect(db.prepare("SELECT task_id FROM agent_run_attempts").all()).toEqual([
      { task_id: "kept" },
    ]);
    expect(db.prepare("SELECT task_id FROM agent_invocations").all()).toEqual([
      { task_id: "kept" },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM parent_notifications").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM lifecycle_operations").all()).toEqual([{ id: "op-gone" }]);
    expect(db.prepare("SELECT id FROM purge_receipts").all()).toEqual([{ id: "receipt-op-gone" }]);
    expect(
      db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'orphaned_%'").all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
