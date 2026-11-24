import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { migrations, queueSteerDeliveryMigration } from "../src/db/migrations.ts";

const database = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (db) => Effect.sync(() => db.close()),
);

const image = "a".repeat(64);

describe("the queue's steer delivery", () => {
  it.effect("its step makes codex's steered deliveries tool-boundary ones and keeps the rows", () =>
    Effect.gen(function* () {
      const db = yield* database;
      // An app from before the step applied every step before it.
      const index = migrations.indexOf(queueSteerDeliveryMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      // A message codex steered in, with an image, and one sent as the next turn.
      db.exec(`
        INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/tmp/p', 'p', '2026-01-01');
        INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', '2026-01-01');
        INSERT INTO attachments (id, mime_type, bytes, created_at)
          VALUES ('${image}', 'image/png', 1, '2026-01-01');
        INSERT INTO queued_messages (id, session_id, seq, text, state, delivered_via, run_id,
          created_at, updated_at)
        VALUES ('steered', 's', 1, 'look', 'delivered', 'steer', 'run-1', 1, 1),
          ('next', 's', 2, 'then', 'delivered', 'next_turn', 'run-2', 2, 2);
        INSERT INTO queued_message_attachments (message_id, position, attachment_id)
          VALUES ('steered', 0, '${image}');
      `);
      const rowids = db.prepare("SELECT rowid, id FROM queued_messages ORDER BY rowid").all();
      db.exec("DELETE FROM secret_sweep_changes");

      // Startup runs every step with foreign keys off (migrateDatabase).
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(queueSteerDeliveryMigration);
      db.exec("PRAGMA foreign_keys = ON");

      expect(db.prepare("SELECT rowid, id FROM queued_messages ORDER BY rowid").all()).toEqual(
        rowids,
      );
      expect(
        db.prepare("SELECT id, delivered_via FROM queued_messages ORDER BY seq").all(),
      ).toEqual([
        { id: "steered", delivered_via: "tool_boundary" },
        { id: "next", delivered_via: "next_turn" },
      ]);
      expect(db.prepare("SELECT message_id FROM queued_message_attachments").all()).toEqual([
        { message_id: "steered" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The table refuses the value, and its triggers still tell the secret sweep of new text.
      expect(() =>
        db.exec(`INSERT INTO queued_messages (id, session_id, seq, text, state, delivered_via,
          created_at, updated_at) VALUES ('x', 's', 3, 'x', 'delivered', 'steer', 3, 3)`),
      ).toThrow(/CHECK constraint failed/);
      db.exec(`UPDATE queued_messages SET text = 'see' WHERE id = 'next'`);
      expect(db.prepare("SELECT target FROM secret_sweep_changes").all()).toEqual([
        { target: "queued_messages" },
      ]);
    }),
  );
});
