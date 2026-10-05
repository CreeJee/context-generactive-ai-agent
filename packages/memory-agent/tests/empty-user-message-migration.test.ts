import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { emptyUserMessageMigration, migrations } from "../src/db/migrations.ts";

test("migration removes only empty user text, preserving payloads, order and timestamps", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrationIndex = migrations.indexOf(emptyUserMessageMigration);
    for (const step of migrations.slice(0, migrationIndex)) db.exec(step);
    db.exec(`PRAGMA user_version = ${migrationIndex}`);
    const empty = { id: "empty", role: "user", content: "", metadata: { tanstack: {} } };
    const retained = [
      { role: "user", content: "hello", createdAt: "old" },
      { role: "assistant", content: "" },
      { role: "tool", content: "", toolCallId: "call" },
      { role: "user", content: [{ type: "image", source: { url: "image" } }] },
      { role: "user", content: "", parts: [{ type: "image", url: "image" }] },
      { role: "user", content: "", toolCalls: [{ id: "call" }] },
      { role: "user", content: "", attachments: ["attachment"] },
      { role: "user", content: "", unknownPayload: "keep" },
      { role: "user", content: " " },
      { role: "user", content: [] },
      { role: "user", content: null },
      { role: "user", content: "last" },
    ];
    const insert = db.prepare("INSERT INTO chat_threads VALUES (?, ?, ?)");
    insert.run(
      "affected",
      JSON.stringify([empty, ...retained.slice(0, 5), empty, ...retained.slice(5), empty]),
      123,
    );
    insert.run("only-empty", JSON.stringify([empty]), 456);
    const untouched = JSON.stringify(retained, null, 2);
    insert.run("untouched", untouched, 789);

    migrateDatabase(db);
    expect(
      JSON.parse(
        String(
          db.prepare("SELECT messages FROM chat_threads WHERE thread_id = 'affected'").get()
            ?.messages,
        ),
      ),
    ).toEqual(retained);
    expect(
      db
        .prepare("SELECT messages, updated_at FROM chat_threads WHERE thread_id = 'only-empty'")
        .get(),
    ).toEqual({ messages: "[]", updated_at: 456 });
    expect(
      db
        .prepare("SELECT messages, updated_at FROM chat_threads WHERE thread_id = 'untouched'")
        .get(),
    ).toEqual({ messages: untouched, updated_at: 789 });
    expect(
      db.prepare("SELECT updated_at FROM chat_threads WHERE thread_id = 'affected'").get(),
    ).toEqual({ updated_at: 123 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
    const before = db.prepare("SELECT * FROM chat_threads ORDER BY thread_id").all();
    db.exec(emptyUserMessageMigration);
    migrateDatabase(db);
    expect(db.prepare("SELECT * FROM chat_threads ORDER BY thread_id").all()).toEqual(before);
  } finally {
    db.close();
  }
});
