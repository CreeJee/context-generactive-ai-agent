import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations, orchestratorNotificationsMigration } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

/** One project with the two conversations a message goes between. */
const twoConversations = `
  INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
  INSERT INTO sessions (id, project_id, created_at)
    VALUES ('from', 'p', '2026-01-01'), ('to', 'p', '2026-01-01');
`;

/** The names of the tables and indexes the session inbox had and the notifications have. */
const tablesAndIndexes = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name IN ('session_inbox', 'session_inbox_waiting', 'session_inbox_claimed', 'orchestrator_notifications', 'orchestrator_notifications_waiting', 'orchestrator_notifications_claimed') ORDER BY name",
    )
    .all();

describe("orchestrator notifications table", () => {
  it.effect("its step moves the session inbox rows and their claims as they are", () =>
    Effect.gen(function* () {
      const db = yield* database;
      // An app from before the new name applied every step before the one that moves the rows.
      const index = migrations.indexOf(orchestratorNotificationsMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      db.exec(twoConversations);
      // One that waits, one a run holds, and one delivered.
      db.exec(`
        INSERT INTO session_inbox (id, session_id, sender, delivery, payload, state,
          claimed_run_id, claimed_at, delivered_run_id, created_at, delivered_at)
        VALUES ('n1', 'to', 'conversation', 'next_run', '{"body":"waits"}', 'waiting', NULL, NULL,
            NULL, '2026-01-01', NULL),
          ('n2', 'to', 'conversation', 'next_run', '{"body":"held"}', 'waiting', 'run-8',
            '2026-01-05', NULL, '2026-01-02', NULL),
          ('n3', 'to', 'conversation', 'next_run', '{"body":"told"}', 'delivered', NULL, NULL,
            'run-9', '2026-01-03', '2026-01-04');
      `);

      db.exec(orchestratorNotificationsMigration);

      expect(db.prepare("SELECT * FROM orchestrator_notifications ORDER BY id").all()).toEqual([
        {
          id: "n1",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"body":"waits"}',
          state: "waiting",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: null,
          created_at: "2026-01-01",
          delivered_at: null,
        },
        {
          id: "n2",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"body":"held"}',
          state: "waiting",
          claimed_run_id: "run-8",
          claimed_at: "2026-01-05",
          delivered_run_id: null,
          created_at: "2026-01-02",
          delivered_at: null,
        },
        {
          id: "n3",
          session_id: "to",
          sender: "conversation",
          delivery: "next_run",
          payload: '{"body":"told"}',
          state: "delivered",
          claimed_run_id: null,
          claimed_at: null,
          delivered_run_id: "run-9",
          created_at: "2026-01-03",
          delivered_at: "2026-01-04",
        },
      ]);
      // The old table took its two indexes with it.
      expect(tablesAndIndexes(db)).toEqual([
        { type: "table", name: "orchestrator_notifications" },
        { type: "index", name: "orchestrator_notifications_claimed" },
        { type: "index", name: "orchestrator_notifications_waiting" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }),
  );

  it.effect("the user is not a sender", () =>
    Effect.gen(function* () {
      const db = yield* database;
      // The whole array, as a fresh app applies it.
      migrations.forEach((step) => db.exec(step));
      db.exec(twoConversations);
      const insert = (sender: string) =>
        db
          .prepare(
            "INSERT INTO orchestrator_notifications (id, session_id, sender, delivery, payload, state, created_at) VALUES (?, 'to', ?, 'next_run', '{}', 'waiting', '2026-01-01')",
          )
          .run(sender, sender);
      // A message the user sent stays in queued_messages.
      expect(() => insert("user")).toThrow();
      insert("task");
      insert("board");
      expect(db.prepare("SELECT sender FROM orchestrator_notifications ORDER BY id").all()).toEqual(
        [{ sender: "board" }, { sender: "task" }],
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }),
  );
});
