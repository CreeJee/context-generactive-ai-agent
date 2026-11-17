import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, notificationDeliveryMigration } from "../src/db/migrations.ts";

it.effect("opening a database gives earlier tasks the delivery of the run that started them", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(notificationDeliveryMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO subagents (id, session_id, status, parent_run_id, last_task, created_at,
        updated_at) VALUES ('a', 's', 'completed', 'run', 'task', 1, 1);
    `);
    const workTask = db.prepare(
      `INSERT INTO work_tasks (id, project_id, origin_session_id, parent_run_id,
        parent_tool_call_id, agent_id, agent_name, status, title, request, created_at, updated_at)
      VALUES (?, 'p', 's', ?, ?, 'a', 'agent', 'completed', 'title', 'request', 1, 1)`,
    );
    const backgroundTask = db.prepare(
      `INSERT INTO background_tasks (id, session_id, parent_run_id, tool_call_id, kind, title,
        status, result, started_at, finished_at)
      VALUES (?, 's', ?, ?, 'shell', 'title', 'completed', 'done', 1, 2)`,
    );
    workTask.run("board-task", "kanban:g:S1:1", "call-1");
    workTask.run("chat-task", "chat-run", "call-2");
    backgroundTask.run("board-shell", "kanban:g:S1:1", "call-3");
    backgroundTask.run("chat-shell", "chat-run", "call-4");

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT id, delivery FROM work_tasks ORDER BY id").all()).toEqual([
      { id: "board-task", delivery: "next_run" },
      { id: "chat-task", delivery: "wake" },
    ]);
    expect(db.prepare("SELECT id, delivery FROM background_tasks ORDER BY id").all()).toEqual([
      { id: "board-shell", delivery: "next_run" },
      { id: "chat-shell", delivery: "wake" },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
  }),
);
