import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, queuedMessageAttachmentsMigration } from "../src/db/migrations.ts";

const first = "a".repeat(64);
const second = "b".repeat(64);
const gone = "c".repeat(64);

it.effect("a queued message's images become rows in the order they were attached", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(queuedMessageAttachmentsMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO attachments (id, mime_type, bytes, created_at) VALUES
        ('${first}', 'image/png', 1, 'old'), ('${second}', 'image/png', 1, 'old');
      INSERT INTO queued_messages
        (id, session_id, seq, text, attachment_ids, state, in_transcript, created_at, updated_at)
        VALUES
        -- An image removed meanwhile and an id that is not a string were left out on delivery.
        ('images', 's', 1, 'look', '["${second}", "${gone}", 5, "${first}"]', 'held', 0, 0, 0),
        ('text', 's', 2, 'plain', '[]', 'held', 0, 0, 0),
        ('odd', 's', 3, 'odd', '{"id": "${first}"}', 'held', 1, 0, 0);
    `);

    yield* migrateDatabase(db);

    expect(
      db
        .prepare(
          "SELECT message_id, position, attachment_id FROM queued_message_attachments ORDER BY message_id, position",
        )
        .all(),
    ).toEqual([
      { message_id: "images", position: 0, attachment_id: second },
      { message_id: "images", position: 3, attachment_id: first },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('queued_messages') WHERE name IN ('attachment_ids', 'in_transcript')",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
