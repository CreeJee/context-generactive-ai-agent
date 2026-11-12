import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { backgroundTasksMigration, migrations } from "../src/db/migrations.ts";

it.effect("background work leaves Work Trace with its saved results, told already", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(backgroundTasksMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    const task = (id: string, session: string, agent: string, status: string) =>
      `('${id}', 'p', ${session}, 'run', 'call-${id}', '${agent}', '${status}', 'T ${id}', 'R', 1, 2)`;
    const attempt = (id: string, thread: string, status: string) =>
      `('a-${id}', '${id}', 'i-${id}', 1, 'run-${id}', '${thread}', '${status}', 1, 2)`;
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO work_tasks
        (id, project_id, origin_session_id, parent_run_id, parent_tool_call_id, agent_name, status,
         title, request, created_at, updated_at)
        VALUES ${task("shell", "'s'", "background_shell", "failed")},
          ${task("agent", "'s'", "background_external_agent", "interrupted")},
          ${task("gone", "NULL", "deleted subagent", "failed")},
          ${task("helper", "'s'", "subagent", "completed")};
      INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message, idempotency_key,
         created_at)
        SELECT 'i-' || id, id, 'run', 'call-' || id, 'start', 'completed', 'R', 'key-' || id, 1
        FROM work_tasks;
      INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status, created_at,
         updated_at)
        VALUES ${attempt("shell", "background-1", "failed")},
          ${attempt("agent", "background-2", "interrupted")},
          ${attempt("gone", "background-3", "failed")},
          ${attempt("helper", "subagent-x", "completed")};
      -- A command that exited non-zero saved its output as a completed result.
      INSERT INTO background_task_results (task_id, status, result)
        VALUES ('shell', 'completed', '{"exitCode":2}');
      INSERT INTO parent_notifications
        (id, project_id, task_id, origin_session_id, parent_run_id, kind, summary, payload,
         idempotency_key, created_at)
        VALUES ('n-shell', 'p', 'shell', 's', 'run', 'failed', 'Background shell failed', '{}',
          'n-shell', 1);
      INSERT INTO lifecycle_operations
        (id, project_id, target_kind, target_id, intent, status, idempotency_key, requested_at,
         updated_at)
        VALUES ('op-gone', 'p', 'task', 'gone', 'delete', 'completed', 'op-gone', 1, 1);
      INSERT INTO purge_receipts
        (id, operation_id, project_id, target_kind, target_id, policy_version, purged_counts,
         retained_kinds, completed_at)
        VALUES ('receipt-gone', 'op-gone', 'p', 'task', 'gone', 1, '{}', '[]', 1);
      UPDATE work_tasks SET purge_receipt_id = 'receipt-gone', deleted_at = 1 WHERE id = 'gone';
    `);

    yield* migrateDatabase(db);

    expect(
      db
        .prepare(
          `SELECT id, session_id, tool_call_id, kind, title, status, result, delivered_to_run_id
           FROM background_tasks ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "agent",
        session_id: "s",
        tool_call_id: "call-agent",
        kind: "external_agent",
        title: "T agent",
        status: "interrupted",
        result: "Result unavailable. Inspect its effects before retrying.",
        delivered_to_run_id: "run",
      },
      {
        id: "shell",
        session_id: "s",
        tool_call_id: "call-shell",
        kind: "shell",
        title: "T shell",
        status: "completed",
        result: '{"exitCode":2}',
        delivered_to_run_id: "run",
      },
    ]);
    // Only the subagent stays in Work Trace, with nothing of the background work around it.
    expect(db.prepare("SELECT id FROM work_tasks").all()).toEqual([{ id: "helper" }]);
    expect(db.prepare("SELECT task_id FROM agent_run_attempts").all()).toEqual([
      { task_id: "helper" },
    ]);
    expect(
      db
        .prepare(
          `SELECT (SELECT count(*) FROM parent_notifications)
             + (SELECT count(*) FROM lifecycle_operations)
             + (SELECT count(*) FROM purge_receipts) AS n`,
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'background_task_results'").all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
