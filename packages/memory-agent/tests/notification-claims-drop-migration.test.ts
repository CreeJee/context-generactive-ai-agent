import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations, notificationClaimsDropMigration } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

describe("the orchestrator notifications without claims", () => {
  it.effect(
    "its step drops the claim columns, settles the claims of finished runs and keeps the rows",
    () =>
      Effect.gen(function* () {
        const db = yield* database;
        // An app from before the step applied every step before it.
        const index = migrations.indexOf(notificationClaimsDropMigration);
        migrations.slice(0, index).forEach((step) => db.exec(step));
        // A row no run held, one a finished run held, one a dead run held, and one delivered.
        db.exec(`
          INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
          INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', '2026-01-01');
          INSERT INTO chat_runs (run_id, thread_id, status, started_at)
          VALUES ('run-done', 's', 'completed', 1), ('run-died', 's', 'running', 1);
          INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state,
            claimed_run_id, claimed_at, delivered_run_id, created_at, delivered_at)
          VALUES
            ('waiting', 's', 'conversation', 'next_run', '{}', 'waiting',
              NULL, NULL, NULL, '2026-01-01', NULL),
            ('finished', 's', 'conversation', 'next_run', '{}', 'waiting',
              'run-done', '2026-01-02', NULL, '2026-01-01', NULL),
            ('died', 's', 'conversation', 'next_run', '{}', 'waiting',
              'run-died', '2026-01-03', NULL, '2026-01-01', NULL),
            ('old', 's', 'conversation', 'next_run', '{}', 'delivered',
              NULL, NULL, 'run-0', '2026-01-01', '2026-01-04');
        `);

        // Startup runs every step with foreign keys off (migrateDatabase).
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec(notificationClaimsDropMigration);
        db.exec("PRAGMA foreign_keys = ON");

        expect(
          db
            .prepare(
              "SELECT id, state, delivered_run_id FROM orchestrator_notifications ORDER BY id",
            )
            .all(),
        ).toEqual([
          { id: "died", state: "waiting", delivered_run_id: null },
          { id: "finished", state: "delivered", delivered_run_id: "run-done" },
          { id: "old", state: "delivered", delivered_run_id: "run-0" },
          { id: "waiting", state: "waiting", delivered_run_id: null },
        ]);
        expect(
          db
            .prepare(
              "SELECT id, delivered_at FROM orchestrator_notifications WHERE state = 'delivered' ORDER BY id",
            )
            .all(),
        ).toEqual([
          { id: "finished", delivered_at: expect.any(String) },
          { id: "old", delivered_at: "2026-01-04" },
        ]);
        const columns = db
          .prepare("PRAGMA table_info(orchestrator_notifications)")
          .all()
          .map((column) => column["name"]);
        expect(columns).not.toContain("claimed_run_id");
        expect(columns).not.toContain("claimed_at");
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestrator_notifications' AND name NOT LIKE 'sqlite_%'",
            )
            .all(),
        ).toEqual([{ name: "orchestrator_notifications_waiting" }]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        // The rows still go with their session.
        db.exec("DELETE FROM sessions WHERE id = 's'");
        expect(db.prepare("SELECT count(*) AS n FROM orchestrator_notifications").get()).toEqual({
          n: 0,
        });
      }),
  );
});
