import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { StoredMessage } from "../src/chat-store/schema.ts";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, threadDisplayMessagesMigration } from "../src/db/migrations.ts";

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(StoredMessage));
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(StoredMessage)));

it.effect("ready pages move with their ids, and the projection's tables go", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(threadDisplayMessagesMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    // The projection as the app made it before this step.
    db.exec(`
      CREATE TABLE chat_history_projection (
        thread_id TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL CHECK (format_version = 1),
        ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
        publication TEXT
      );
      CREATE TABLE chat_history_groups (
        thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        ui_id TEXT NOT NULL,
        messages TEXT NOT NULL CHECK (json_valid(messages) AND json_type(messages) = 'array'),
        PRIMARY KEY (thread_id, ordinal),
        UNIQUE (thread_id, ui_id)
      );
      CREATE TRIGGER chat_history_invalidate_revision AFTER UPDATE OF revision ON chat_threads
      BEGIN UPDATE chat_history_projection SET ready = 0 WHERE thread_id = NEW.thread_id; END;
      CREATE TRIGGER chat_history_invalidate_delete AFTER DELETE ON chat_threads BEGIN
        DELETE FROM chat_history_groups WHERE thread_id = OLD.thread_id;
        DELETE FROM chat_history_projection WHERE thread_id = OLD.thread_id;
      END;
    `);
    const messages: ReadonlyArray<StoredMessage> = [
      { role: "user", content: "Legacy question" },
      { id: "a", role: "assistant", content: "Checking" },
      { role: "tool", toolCallId: "call", content: "Result" },
      { id: "u", role: "user", content: "Next" },
    ];
    const writeThread = db.prepare(
      "INSERT INTO chat_threads (thread_id, updated_at) VALUES (?, 1)",
    );
    const writeMessage = db.prepare("INSERT INTO chat_thread_messages VALUES (?, ?, ?)");
    const texts = yield* Effect.forEach(messages, (message) => encodeMessage(message));
    for (const threadId of ["ready", "stale", "short", "never"]) {
      writeThread.run(threadId);
      texts.forEach((text, seq) => writeMessage.run(threadId, seq, text));
    }
    writeThread.run("empty");
    const group = (threadId: string, ordinal: number, uiId: string, from: number, to: number) =>
      Effect.map(encodeThread(messages.slice(from, to)), (text) =>
        db
          .prepare("INSERT INTO chat_history_groups VALUES (?, ?, ?, ?)")
          .run(threadId, ordinal, uiId, text),
      );
    yield* Effect.forEach(["ready", "stale"], (threadId) =>
      Effect.all([
        group(threadId, 0, `stored:${threadId}:0`, 0, 1),
        group(threadId, 1, "a", 1, 3),
        group(threadId, 2, "u", 3, 4),
      ]),
    );
    // Groups that miss the last message do not move.
    yield* group("short", 0, "stored:short:0", 0, 1);
    db.exec(`
      INSERT INTO chat_history_projection VALUES
        ('ready', 1, 1, 'p'), ('stale', 1, 0, 'p'), ('short', 1, 1, 'p');
    `);

    yield* migrateDatabase(db);
    expect(
      db
        .prepare(
          `SELECT thread_id, seq, display_id, first_message_seq FROM chat_thread_display_messages
            ORDER BY thread_id, seq`,
        )
        .all(),
    ).toEqual([
      { thread_id: "ready", seq: 0, display_id: "stored:ready:0", first_message_seq: 0 },
      { thread_id: "ready", seq: 1, display_id: "a", first_message_seq: 1 },
      { thread_id: "ready", seq: 2, display_id: "u", first_message_seq: 3 },
    ]);
    const current = db.prepare(
      `SELECT thread_id, display_format IS 1 AND display_revision IS revision AS current
        FROM chat_threads ORDER BY thread_id`,
    );
    expect(current.all()).toEqual([
      { thread_id: "empty", current: 1 },
      { thread_id: "never", current: 0 },
      { thread_id: "ready", current: 1 },
      { thread_id: "short", current: 0 },
      { thread_id: "stale", current: 0 },
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name LIKE 'chat_history%' OR name LIKE 'moved_%' ORDER BY name`,
        )
        .all(),
    ).toEqual([]);

    // Text hidden in place keeps the shown messages current; a changed id does not.
    const update = db.prepare(
      "UPDATE chat_thread_messages SET message = ? WHERE thread_id = 'ready' AND seq = ?",
    );
    update.run(yield* encodeMessage({ role: "user", content: "[redacted]" }), 0);
    expect(current.all()).toContainEqual({ thread_id: "ready", current: 1 });
    update.run(yield* encodeMessage({ id: "b", role: "assistant", content: "Checking" }), 1);
    expect(current.all()).toContainEqual({ thread_id: "ready", current: 0 });
    // Deleting a thread deletes what it showed.
    db.exec("DELETE FROM chat_threads WHERE thread_id = 'ready'");
    expect(db.prepare("SELECT count(*) AS count FROM chat_thread_display_messages").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);

it.effect("a database that never made the projection gets the step all the same", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    yield* migrateDatabase(db);
    expect(
      db
        .prepare("PRAGMA table_info(chat_threads)")
        .all()
        .map((column) => column.name),
    ).toEqual(["thread_id", "updated_at", "revision", "display_revision", "display_format"]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'chat_history%'").all(),
    ).toEqual([]);
  }),
);
