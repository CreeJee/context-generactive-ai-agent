import { DatabaseSync } from "node:sqlite";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { expect, test } from "vite-plus/test";
import { migrations } from "../src/db/migrations.ts";
import { migrateLegacyChatThreads, sqliteChatPersistence } from "../src/chat-state/persistence.ts";

function freshPersistence() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  return sqliteChatPersistence(sqlite);
}

// The TanStack contract suite: full-replace threads, idempotent runs and interrupts, ordering,
// NULL clears for durable-run fields, composite metadata keys. Generation stores are not used.
runPersistenceConformance("sqlite chat state", freshPersistence, {
  skip: ["generationRuns", "artifacts", "blobs"],
});

test("materializes legacy session transcripts without overwriting persisted chat", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
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
    .run("persisted", JSON.stringify([{ role: "assistant", content: "keep me" }]), 1);

  const migrated = migrateLegacyChatThreads(sqlite, (threadId) => [
    { role: "user", content: `rebuilt ${threadId}` },
  ]);
  expect(migrated).toBe(1);
  expect(migrateLegacyChatThreads(sqlite, () => [])).toBe(0);

  const persistence = sqliteChatPersistence(sqlite);
  await expect(persistence.stores.messages.loadThread("legacy")).resolves.toEqual([
    { role: "user", content: "rebuilt legacy" },
  ]);
  await expect(persistence.stores.messages.loadThread("persisted")).resolves.toEqual([
    { role: "assistant", content: "keep me" },
  ]);
  sqlite.close();
});
