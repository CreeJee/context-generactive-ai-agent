import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { boardTasksRestartEndMigration, migrations } from "../src/db/migrations.ts";

it.effect(
  "opening a database ends the board's tasks a restart left unfinished, and only those",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (db) => Effect.sync(() => db.close()),
      );
      const index = migrations.indexOf(boardTasksRestartEndMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      db.exec(`PRAGMA user_version = ${index}`);
      const task = (id: string, parentRunId: string, status: string) =>
        db
          .prepare(
            `INSERT INTO work_tasks (id, project_id, origin_session_id, parent_run_id,
              parent_tool_call_id, agent_id, agent_name, status, title, request, created_at,
              updated_at)
            VALUES (?, 'p', 's', ?, ?, 'a', 'agent', ?, 'title', 'request', 1, 1)`,
          )
          .run(id, parentRunId, parentRunId, status);
      db.exec(`
        INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
        INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
        INSERT INTO subagents (id, session_id, status, parent_run_id, last_task, created_at,
          updated_at) VALUES ('a', 's', 'interrupted', 'run', 'task', 1, 1);
      `);
      task("board-blocked", "kanban:g:outcome:O1:verify:x", "blocked");
      task("board-resumable", "kanban:g:S1:1", "resumable");
      task("board-interrupted", "kanban:g:goal:verify:x", "interrupted");
      task("board-completed", "kanban:g:S2:1", "completed");
      task("chat-blocked", "chat-run", "blocked");
      task("chat-resumable", "chat-run", "resumable");

      yield* migrateDatabase(db);

      expect(db.prepare("SELECT id, status FROM work_tasks ORDER BY id").all()).toEqual([
        { id: "board-blocked", status: "failed" },
        { id: "board-completed", status: "completed" },
        { id: "board-interrupted", status: "failed" },
        { id: "board-resumable", status: "failed" },
        { id: "chat-blocked", status: "blocked" },
        { id: "chat-resumable", status: "resumable" },
      ]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
    }),
);
