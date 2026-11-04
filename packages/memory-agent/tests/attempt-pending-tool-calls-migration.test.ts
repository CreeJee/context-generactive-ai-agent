import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { attemptPendingToolCallsMigration, migrations } from "../src/db/migrations.ts";

it.effect("an attempt's unsettled tool calls become rows in the order they started", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(attemptPendingToolCallsMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO work_tasks
        (id, project_id, parent_run_id, parent_tool_call_id, agent_name, status, title, request,
         created_at, updated_at)
        VALUES ('task', 'p', 'parent', 'call', 'helper', 'running', 'Task', 'Do it', 1, 1);
      INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
         idempotency_key, created_at)
        VALUES ('start', 'task', 'parent', 'call', 'start', 'running', 'Do it', 'start:call', 1),
          ('resume', 'task', 'parent', 'call', 'resume', 'running', 'Again', 'resume:call', 2);
      INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
         created_at, updated_at, pending_tool_call_ids)
        VALUES ('first', 'task', 'start', 1, 'run-1', 'thread', 'interrupted', 1, 1, '[]'),
          -- A call started twice is pending once; a number never named a call.
          ('second', 'task', 'resume', 2, 'run-2', 'thread', 'running', 2, 2,
            '["write", "read", "write", 5]');
    `);

    yield* migrateDatabase(db);

    expect(
      db
        .prepare("SELECT attempt_id, tool_call_id FROM attempt_pending_tool_calls ORDER BY rowid")
        .all(),
    ).toEqual([
      { attempt_id: "second", tool_call_id: "write" },
      { attempt_id: "second", tool_call_id: "read" },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('agent_run_attempts') WHERE name LIKE 'pending%'",
        )
        .all(),
    ).toEqual([]);
  }),
);
