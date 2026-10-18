import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "@tanstack/ai";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { afterAll, expect } from "vite-plus/test";
import { connectionContext } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  migrateLegacyChatThreads,
  migrateMissingChatThread,
  chatPersistence,
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
/** Runs a chat-state migration over the fixture's connection. */
const over =
  (sqlite: DatabaseSync) =>
  <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.flatMap(connectionContext(sqlite), (context) => Effect.provideContext(effect, context));
const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });
function freshPersistence() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  conformanceDatabases.push(sqlite);
  return Effect.runPromise(over(sqlite)(chatPersistence));
}

// The TanStack contract suite: full-replace threads, idempotent runs and interrupts, ordering,
// NULL clears for durable-run fields, composite metadata keys. Generation stores are not used.
runPersistenceConformance("sqlite chat state", freshPersistence, {
  skip: ["generationRuns", "artifacts", "blobs"],
});

it.live("does not persist empty user text, preserving tool-only answers and media", () =>
  Effect.gen(function* () {
    const sqlite = yield* database;
    const persistence = yield* over(sqlite)(chatPersistence);
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

    const migrated = yield* over(sqlite)(
      migrateLegacyChatThreads((threadId) =>
        Effect.succeed<ModelMessage[]>([{ role: "user", content: `rebuilt ${threadId}` }]),
      ),
    );
    expect(migrated).toBe(1);
    expect(yield* over(sqlite)(migrateLegacyChatThreads(() => Effect.succeed([])))).toBe(0);

    const persistence = yield* over(sqlite)(chatPersistence);
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
    expect(yield* over(sqlite)(migrateLegacyChatThreads(() => Effect.succeed([])))).toBe(0);
    sqlite
      .prepare("INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)")
      .run("imported", "project", "2026-01-02T00:00:00.000Z");

    const transcript: ModelMessage[] = [{ role: "user", content: "imported transcript" }];
    const rebuilt = () => Effect.succeed(transcript);
    const missing = (threadId: string, fallback: typeof rebuilt) =>
      over(sqlite)(migrateMissingChatThread(threadId, fallback));
    expect(yield* missing("imported", rebuilt)).toBe(true);
    expect(yield* missing("imported", () => Effect.succeed([]))).toBe(false);
    expect(yield* missing("unknown", rebuilt)).toBe(false);
    const persistence = yield* over(sqlite)(chatPersistence);
    expect(yield* call(() => persistence.stores.messages.loadThread("imported"))).toEqual(
      transcript,
    );
  }),
);
