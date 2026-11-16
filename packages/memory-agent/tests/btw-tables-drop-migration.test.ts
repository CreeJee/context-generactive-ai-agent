import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { btwTablesDropMigration, migrations } from "../src/db/migrations.ts";

it.effect("opening a database drops the BTW tables and the threads they held", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const attachmentId = "a".repeat(64);
    const index = migrations.indexOf(btwTablesDropMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO attachments (id, mime_type, bytes, created_at)
        VALUES ('${attachmentId}', 'image/png', 1, 'old');
      INSERT INTO btw_threads (id, parent_session_id, created_at, updated_at) VALUES ('t', 's', 'old', 1);
      INSERT INTO btw_thread_messages (thread_id, seq, message) VALUES ('t', 0, '{"role":"user"}');
      INSERT INTO btw_attachments (thread_id, attachment_id) VALUES ('t', '${attachmentId}');
    `);

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'btw%'").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "s" }]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
