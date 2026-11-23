import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { backgroundEndsNotificationsMigration, migrations } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

/** A background task row as the schema before the step keeps it, with whether its end was told. */
const task = (row: {
  readonly id: string;
  readonly parentRunId: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly finishedAt: number | null;
  readonly deliveredToRunId: string | null;
  readonly deliveredAt: number | null;
  readonly delivery: string;
}) =>
  `('${row.id}', 's', '${row.parentRunId}', 'call-${row.id}', '${row.kind}', '${row.title}',
    '${row.status}', ${row.finishedAt === null ? "NULL" : "'saved'"}, 1767225600000,
    ${row.finishedAt ?? "NULL"}, ${row.deliveredToRunId === null ? "NULL" : `'${row.deliveredToRunId}'`},
    ${row.deliveredAt ?? "NULL"}, '${row.delivery}')`;

describe("background ends in the orchestrator's notifications", () => {
  it.effect(
    "the newest schema keeps a task's delivery and nothing of whether its end was told",
    () =>
      Effect.gen(function* () {
        const db = yield* database;
        // The whole array, as a fresh app applies it.
        migrations.forEach((step) => db.exec(step));
        const columns = db
          .prepare("PRAGMA table_info(background_tasks)")
          .all()
          .map((column) => column["name"]);
        expect(columns).toContain("delivery");
        expect(columns).not.toContain("delivered_to_run_id");
        expect(columns).not.toContain("delivered_at");
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name = 'background_tasks_untold'").all(),
        ).toEqual([]);
      }),
  );

  it.effect("its step gives every ended task one notification, told or still waiting", () =>
    Effect.gen(function* () {
      const db = yield* database;
      // An app from before the step applied every step before it.
      const index = migrations.indexOf(backgroundEndsNotificationsMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      // One still running, two ended and not told (one the board started), and one told.
      db.exec(`
        INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
        INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', '2026-01-01');
        INSERT INTO background_tasks (id, session_id, parent_run_id, tool_call_id, kind, title,
          status, result, started_at, finished_at, delivered_to_run_id, delivered_at, delivery)
        VALUES ${task({ id: "running", parentRunId: "run-1", kind: "shell", title: "sleep 60", status: "running", finishedAt: null, deliveredToRunId: null, deliveredAt: null, delivery: "wake" })},
          ${task({ id: "untold", parentRunId: "run-1", kind: "shell", title: "ls", status: "completed", finishedAt: 1767225600123, deliveredToRunId: null, deliveredAt: null, delivery: "wake" })},
          ${task({ id: "board", parentRunId: "kanban:s:S1:1", kind: "external_agent", title: "review", status: "failed", finishedAt: 1767225600500, deliveredToRunId: null, deliveredAt: null, delivery: "next_run" })},
          ${task({ id: "told", parentRunId: "run-1", kind: "shell", title: "pwd", status: "cancelled", finishedAt: 1767225600900, deliveredToRunId: "run-told", deliveredAt: 1767225601000, delivery: "wake" })};
      `);

      db.exec(backgroundEndsNotificationsMigration);

      expect(
        db
          .prepare(
            `SELECT id, session_id, sender, delivery, state, claimed_run_id, claimed_at,
               delivered_run_id, created_at, delivered_at,
               json_extract(payload, '$._tag') AS tag,
               json_extract(payload, '$.taskId') AS task_id,
               json_extract(payload, '$.parentRunId') AS parent_run_id,
               json_extract(payload, '$.kind') AS kind,
               json_extract(payload, '$.title') AS title,
               json_extract(payload, '$.status') AS status
             FROM orchestrator_notifications ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "board",
          session_id: "s",
          sender: "task",
          delivery: "next_run",
          state: "waiting",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: null,
          created_at: "2026-01-01T00:00:00.500Z",
          delivered_at: null,
          tag: "BackgroundEnd",
          task_id: "board",
          parent_run_id: "kanban:s:S1:1",
          kind: "external_agent",
          title: "review",
          status: "failed",
        },
        {
          id: "told",
          session_id: "s",
          sender: "task",
          delivery: "wake",
          state: "delivered",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: "run-told",
          created_at: "2026-01-01T00:00:00.900Z",
          delivered_at: "2026-01-01T00:00:01.000Z",
          tag: "BackgroundEnd",
          task_id: "told",
          parent_run_id: "run-1",
          kind: "shell",
          title: "pwd",
          status: "cancelled",
        },
        {
          id: "untold",
          session_id: "s",
          sender: "task",
          delivery: "wake",
          state: "waiting",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: null,
          created_at: "2026-01-01T00:00:00.123Z",
          delivered_at: null,
          tag: "BackgroundEnd",
          task_id: "untold",
          parent_run_id: "run-1",
          kind: "shell",
          title: "ls",
          status: "completed",
        },
      ]);
      // The task rows stay, the running one too, with the delivery each was started with.
      expect(db.prepare("SELECT id, delivery FROM background_tasks ORDER BY id").all()).toEqual([
        { id: "board", delivery: "next_run" },
        { id: "running", delivery: "wake" },
        { id: "told", delivery: "wake" },
        { id: "untold", delivery: "wake" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }),
  );
});
