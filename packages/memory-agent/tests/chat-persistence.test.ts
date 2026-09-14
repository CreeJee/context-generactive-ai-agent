import { DatabaseSync } from "node:sqlite";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { migrations } from "../src/db/migrations.ts";
import { sqliteChatPersistence } from "../src/chat-state/persistence.ts";

function freshPersistence() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  return sqliteChatPersistence(sqlite, () => []);
}

// The TanStack contract suite: full-replace threads, idempotent runs and interrupts, ordering,
// NULL clears for durable-run fields, composite metadata keys. Generation stores are not used.
runPersistenceConformance("sqlite chat state", freshPersistence, {
  skip: ["generationRuns", "artifacts", "blobs"],
});
