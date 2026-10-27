import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, tanStackRowsMigration } from "../src/db/migrations.ts";

test("opening a database moves the chat rows TanStack wrote, BTW threads included", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const index = migrations.indexOf(tanStackRowsMigration);
    for (const step of migrations.slice(0, index)) db.exec(step);
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(
      "INSERT INTO projects (id, root, name, created_at) VALUES ('project', '/tmp/project', 'project', 'old')",
    );
    db.exec(
      "INSERT INTO sessions (id, project_id, created_at) VALUES ('session', 'project', 'old')",
    );
    const answer = {
      role: "assistant",
      id: "answer",
      content: "done",
      metadata: { tanstack: { createdAt: "2026-10-01T00:00:00.000Z", model: "gpt", index: 0 } },
    };
    const moved = {
      role: "assistant",
      id: "answer",
      content: "done",
      createdAt: "2026-10-01T00:00:00.000Z",
      model: "gpt",
    };
    db.prepare("INSERT INTO chat_threads VALUES (?, ?, ?)").run(
      "session",
      JSON.stringify([answer]),
      1,
    );
    db.prepare(
      "INSERT INTO btw_threads (id, parent_session_id, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("btw", "session", JSON.stringify([answer]), "old", 1);

    migrateDatabase(db);
    const messages = (sql: string) => JSON.parse(String(db.prepare(sql).get()?.messages));
    expect(messages("SELECT messages FROM chat_threads WHERE thread_id = 'session'")).toEqual([
      moved,
    ]);
    expect(messages("SELECT messages FROM btw_threads WHERE id = 'btw'")).toEqual([moved]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
  } finally {
    db.close();
  }
});
