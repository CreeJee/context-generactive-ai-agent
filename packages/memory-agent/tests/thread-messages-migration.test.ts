import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { releasedProjectionSchema } from "../src/chat-store/tanstack-migration.ts";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, threadMessagesMigration } from "../src/db/migrations.ts";
import { JsonValue } from "../src/json.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(JsonValue));

it.effect("moving transcripts to message rows keeps their text, sweep marks and ready pages", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(threadMessagesMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    // The pages as a released database has them; the TanStack step made their tables.
    db.exec(releasedProjectionSchema);
    db.exec(`PRAGMA user_version = ${index}`);
    const messages: ReadonlyArray<JsonValue> = [
      { id: "u", role: "user", content: '줄\n바꿈 "따옴표"   😀 \ud800' },
      {
        id: "a",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "c", content: [{ type: "text", content: "1.50" }] },
    ];
    const text = yield* encodeJson(messages);
    const insert = db.prepare(
      "INSERT INTO chat_threads (thread_id, messages, updated_at) VALUES (?, ?, ?)",
    );
    insert.run("swept", text, 1);
    insert.run("pending", text, 2);
    insert.run("empty", "[]", 3);
    db.exec(`
        INSERT INTO chat_history_projection VALUES ('swept', 1, 1), ('pending', 1, 1);
        INSERT INTO secret_sweeps (target, version, after, done, hidden, updated_at)
          VALUES ('chat_threads', 1, 0, 1, 2, '2026-11-04');
        DELETE FROM secret_sweep_changes
          WHERE row_key = (SELECT rowid FROM chat_threads WHERE thread_id = 'swept');
      `);
    const revisions = db.prepare("SELECT thread_id, revision FROM chat_threads ORDER BY thread_id");
    const before = revisions.all();

    yield* migrateDatabase(db);
    const transcript = db.prepare(
      `SELECT '[' || COALESCE(group_concat(message, ',' ORDER BY seq), '') || ']' AS messages
          FROM chat_thread_messages WHERE thread_id = ?`,
    );
    expect(transcript.get("swept")).toEqual({ messages: text });
    expect(transcript.get("pending")).toEqual({ messages: text });
    expect(transcript.get("empty")).toEqual({ messages: "[]" });
    expect(
      db
        .prepare("PRAGMA table_info(chat_threads)")
        .all()
        .map((column) => column.name),
    ).toEqual(["thread_id", "updated_at", "revision"]);
    // Moving the messages is no change to them: no new revision, and the pages stay ready.
    expect(revisions.all()).toEqual(before);
    expect(
      db.prepare("SELECT thread_id, ready FROM chat_history_projection ORDER BY thread_id").all(),
    ).toEqual([
      { thread_id: "pending", ready: 1 },
      { thread_id: "swept", ready: 1 },
    ]);
    // The thread the sweep had yet to read is now its messages, and the progress moved with it.
    expect(
      db
        .prepare(
          `SELECT m.thread_id, m.seq FROM secret_sweep_changes c
              JOIN chat_thread_messages m ON m.rowid = c.row_key
              WHERE c.target = 'chat_thread_messages' ORDER BY m.thread_id, m.seq`,
        )
        .all(),
    ).toEqual([
      { thread_id: "pending", seq: 0 },
      { thread_id: "pending", seq: 1 },
      { thread_id: "pending", seq: 2 },
    ]);
    expect(
      db
        .prepare("SELECT count(*) AS count FROM secret_sweep_changes WHERE target = 'chat_threads'")
        .get(),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT target, hidden FROM secret_sweeps").all()).toEqual([
      { target: "chat_thread_messages", hidden: 2 },
    ]);

    // A message written from now on gives its thread a new revision.
    const revisionOf = (threadId: string) =>
      db.prepare("SELECT revision FROM chat_threads WHERE thread_id = ?").get(threadId);
    const emptyBefore = revisionOf("empty");
    db.prepare("INSERT INTO chat_thread_messages VALUES ('empty', 0, ?)").run(
      yield* encodeJson({ role: "user", content: "next" }),
    );
    expect(revisionOf("empty")).not.toEqual(emptyBefore);
    // Deleting a thread deletes its messages.
    db.exec("DELETE FROM chat_threads WHERE thread_id = 'swept'");
    expect(transcript.get("swept")).toEqual({ messages: "[]" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
