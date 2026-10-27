import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, tanStackRowsMigration } from "../src/db/migrations.ts";
import { JsonValue } from "../src/json.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(JsonValue));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValue));

it.effect("opening a database moves the chat rows TanStack wrote, BTW threads included", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(tanStackRowsMigration);
    for (const step of migrations.slice(0, index)) db.exec(step);
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(
      "INSERT INTO projects (id, root, name, created_at) VALUES ('project', '/tmp/project', 'project', 'old')",
    );
    db.exec(
      "INSERT INTO sessions (id, project_id, created_at) VALUES ('session', 'project', 'old')",
    );
    const answer: JsonValue = {
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
      yield* encodeJson([answer]),
      1,
    );
    db.prepare(
      "INSERT INTO btw_threads (id, parent_session_id, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("btw", "session", yield* encodeJson([answer]), "old", 1);

    yield* migrateDatabase(db);
    const messages = (sql: string) => decodeJson(db.prepare(sql).get()?.messages);
    expect(
      yield* messages("SELECT messages FROM chat_threads WHERE thread_id = 'session'"),
    ).toEqual([moved]);
    expect(yield* messages("SELECT messages FROM btw_threads WHERE id = 'btw'")).toEqual([moved]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
  }),
);
