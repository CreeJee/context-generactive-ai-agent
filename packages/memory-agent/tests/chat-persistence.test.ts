import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "@tanstack/ai";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { afterAll, expect } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import {
  migrateLegacyChatThreads,
  migrateMissingChatThread,
  sqliteChatPersistence,
} from "../src/chat-state/persistence.ts";

const conformanceDatabases: DatabaseSync[] = [];
afterAll(() => {
  for (const sqlite of conformanceDatabases.splice(0)) sqlite.close();
});
const database = Effect.acquireRelease(
  Effect.sync(() => {
    const sqlite = new DatabaseSync(":memory:");
    for (const migration of migrations) sqlite.exec(migration);
    return sqlite;
  }),
  (sqlite) => Effect.sync(() => sqlite.close()),
);
const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });
function freshPersistence() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  conformanceDatabases.push(sqlite);
  return sqliteChatPersistence(sqlite);
}

// The TanStack contract suite: full-replace threads, idempotent runs and interrupts, ordering,
// NULL clears for durable-run fields, composite metadata keys. Generation stores are not used.
runPersistenceConformance("sqlite chat state", freshPersistence, {
  skip: ["generationRuns", "artifacts", "blobs"],
});

it.live("does not persist empty user text, preserving tool-only answers and media", () =>
  Effect.gen(function* () {
    const sqlite = yield* database;
    const persistence = sqliteChatPersistence(sqlite);
    const attachmentMessage = { role: "user" as const, content: "", attachments: ["attachment"] };
    const retained: ModelMessage[] = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "", toolCallId: "call" },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", value: "https://example.com/image.png" } },
        ],
      },
      attachmentMessage,
    ];
    yield* call(() =>
      persistence.stores.messages.saveThread("thread", [
        { id: "empty", role: "user", content: "", metadata: { tanstack: {} } },
        ...retained,
      ]),
    );
    expect(yield* call(() => persistence.stores.messages.loadThread("thread"))).toEqual(retained);
  }),
);

it.live("materializes legacy session transcripts without overwriting persisted chat", () =>
  Effect.gen(function* () {
    const sqlite = yield* database;
    sqlite
      .prepare("INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)")
      .run("project", "/tmp/project", "project", "2026-01-01T00:00:00.000Z");
    const insertSession = sqlite.prepare(
      "INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)",
    );
    insertSession.run("legacy", "project", "2026-01-01T00:00:00.000Z");
    insertSession.run("persisted", "project", "2026-01-02T00:00:00.000Z");
    sqlite
      .prepare("INSERT INTO chat_threads (thread_id, messages, updated_at) VALUES (?, ?, ?)")
      .run(
        "persisted",
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
          { role: "assistant", content: "keep me" },
        ]),
        1,
      );

    const migrated = migrateLegacyChatThreads(sqlite, (threadId) => [
      { role: "user", content: `rebuilt ${threadId}` },
    ]);
    expect(migrated).toBe(1);
    expect(migrateLegacyChatThreads(sqlite, () => [])).toBe(0);

    const persistence = sqliteChatPersistence(sqlite);
    expect(yield* call(() => persistence.stores.messages.loadThread("legacy"))).toEqual([
      { role: "user", content: "rebuilt legacy" },
    ]);
    expect(yield* call(() => persistence.stores.messages.loadThread("persisted"))).toEqual([
      { role: "assistant", content: "keep me" },
    ]);
  }),
);

it.live("materializes a session imported after startup when its chat is first opened", () =>
  Effect.gen(function* () {
    const sqlite = yield* database;
    sqlite
      .prepare("INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)")
      .run("project", "/tmp/project", "project", "2026-01-01T00:00:00.000Z");
    expect(migrateLegacyChatThreads(sqlite, () => [])).toBe(0);
    sqlite
      .prepare("INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)")
      .run("imported", "project", "2026-01-02T00:00:00.000Z");

    const rebuilt = () => [{ role: "user" as const, content: "imported transcript" }];
    expect(migrateMissingChatThread(sqlite, "imported", rebuilt)).toBe(true);
    expect(migrateMissingChatThread(sqlite, "imported", () => [])).toBe(false);
    expect(migrateMissingChatThread(sqlite, "unknown", rebuilt)).toBe(false);
    const persistence = sqliteChatPersistence(sqlite);
    expect(yield* call(() => persistence.stores.messages.loadThread("imported"))).toEqual(
      rebuilt(),
    );
  }),
);
