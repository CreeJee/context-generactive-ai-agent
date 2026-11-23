import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations, sessionInboxMigration } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

/** One project with the two conversations a dispatch goes between. */
const twoConversations = `
  INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
  INSERT INTO sessions (id, project_id, created_at)
    VALUES ('from', 'p', '2026-01-01'), ('to', 'p', '2026-01-01');
`;

describe("session inbox table", () => {
  it.effect(
    "the newest schema has neither the inbox nor the dispatch tables, only the orchestrator's notifications",
    () =>
      Effect.gen(function* () {
        const db = yield* database;
        // The whole array, as a fresh app applies it.
        migrations.forEach((step) => db.exec(step));
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('orchestrator_notifications', 'session_inbox', 'session_dispatches', 'session_dispatch_claims')",
            )
            .all(),
        ).toEqual([{ name: "orchestrator_notifications" }]);
      }),
  );

  it.effect("its step moves the stored dispatches and their claims into the inbox", () =>
    Effect.gen(function* () {
      const db = yield* database;
      // An app from before the inbox applied every step before the one that creates it.
      const index = migrations.indexOf(sessionInboxMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      db.exec(twoConversations);
      // One that waits, one a run holds, and one delivered whose claim was never dropped.
      db.exec(`
        INSERT INTO session_dispatches (id, project_id, from_session_id, from_run_id, to_session_id,
          body, state, delivered_run_id, created_at, delivered_at)
        VALUES ('d1', 'p', 'from', 'run-1', 'to', 'waits', 'waiting', NULL, '2026-01-01', NULL),
          ('d2', 'p', 'from', 'run-2', 'to', 'held', 'waiting', NULL, '2026-01-02', NULL),
          ('d3', 'p', 'from', 'run-3', 'to', 'told', 'delivered', 'run-9', '2026-01-03',
            '2026-01-04');
        INSERT INTO session_dispatch_claims (dispatch_id, run_id, claimed_at)
        VALUES ('d2', 'run-8', '2026-01-05'), ('d3', 'run-9', '2026-01-04');
      `);

      db.exec(sessionInboxMigration);

      expect(db.prepare("SELECT * FROM session_inbox ORDER BY id").all()).toEqual([
        {
          id: "d1",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"projectId":"p","fromSessionId":"from","fromRunId":"run-1","body":"waits"}',
          state: "waiting",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: null,
          created_at: "2026-01-01",
          delivered_at: null,
        },
        {
          id: "d2",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"projectId":"p","fromSessionId":"from","fromRunId":"run-2","body":"held"}',
          state: "waiting",
          claimed_run_id: "run-8",
          claimed_at: "2026-01-05",
          delivered_run_id: null,
          created_at: "2026-01-02",
          delivered_at: null,
        },
        {
          id: "d3",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"projectId":"p","fromSessionId":"from","fromRunId":"run-3","body":"told"}',
          state: "delivered",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: "run-9",
          created_at: "2026-01-03",
          delivered_at: "2026-01-04",
        },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }),
  );

  it.effect("a delivered row without the run that delivered it is refused", () =>
    Effect.gen(function* () {
      const db = yield* database;
      migrations.forEach((step) => db.exec(step));
      db.exec(twoConversations);
      const insert = (state: string, deliveredRunId: string | null, deliveredAt: string | null) =>
        db
          .prepare(
            "INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state, delivered_run_id, created_at, delivered_at) VALUES (?, 'to', 'conversation', 'next_run', '{}', ?, ?, '2026-01-01', ?)",
          )
          .run(`${state}-${deliveredRunId}`, state, deliveredRunId, deliveredAt);
      expect(() => insert("delivered", null, "2026-01-02")).toThrow();
      // Delivering writes both fields at once.
      insert("delivered", "run-2", "2026-01-02");
    }),
  );
});
