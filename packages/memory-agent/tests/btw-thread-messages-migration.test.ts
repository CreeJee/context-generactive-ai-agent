import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { btwThreadMessagesMigration, migrations } from "../src/db/migrations.ts";

it.effect("a BTW thread's transcript becomes one row per message, in order", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(btwThreadMessagesMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO btw_threads (id, parent_session_id, messages, created_at, updated_at) VALUES
        ('asked', 's', '[{"role":"user","id":"q","content":"why?"},{"role":"assistant","id":"a","content":"because"}]', 'old', 1),
        ('empty', 's', '[]', 'old', 1),
        ('odd', 's', '{"role":"user"}', 'old', 1);
    `);

    yield* migrateDatabase(db);

    expect(
      db
        .prepare("SELECT thread_id, seq, message FROM btw_thread_messages ORDER BY thread_id, seq")
        .all(),
    ).toEqual([
      { thread_id: "asked", seq: 0, message: '{"role":"user","id":"q","content":"why?"}' },
      { thread_id: "asked", seq: 1, message: '{"role":"assistant","id":"a","content":"because"}' },
    ]);
    expect(db.prepare("SELECT id FROM btw_threads ORDER BY id").all()).toEqual([
      { id: "asked" },
      { id: "empty" },
      { id: "odd" },
    ]);
    expect(
      db.prepare("SELECT name FROM pragma_table_info('btw_threads') WHERE name = 'messages'").all(),
    ).toEqual([]);
  }),
);
