import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { importedSessionSourceMigration, migrations } from "../src/db/migrations.ts";

it.effect("a session's import source is read from its transcript mapping", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(importedSessionSourceMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at, imported_from) VALUES
        ('mapped', 'p', 'old', 'codex'), ('twice', 'p', 'old', 'claude-code'),
        ('unmapped', 'p', 'old', 'codex'), ('local', 'p', 'old', NULL);
      INSERT INTO imported_sessions (source, external_id, session_id) VALUES
        ('codex', 'one', 'mapped'),
        -- One transcript makes one session; a second mapping only comes from a damaged file.
        ('claude-code', 'two', 'twice'), ('claude-code', 'three', 'twice');
    `);

    yield* migrateDatabase(db);

    expect(
      db
        .prepare(
          `SELECT s.id, i.source, i.external_id FROM sessions s
            LEFT JOIN imported_sessions i ON i.session_id = s.id ORDER BY s.id`,
        )
        .all(),
    ).toEqual([
      { id: "local", source: null, external_id: null },
      { id: "mapped", source: "codex", external_id: "one" },
      { id: "twice", source: "claude-code", external_id: "two" },
      { id: "unmapped", source: null, external_id: null },
    ]);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'imported_from'")
        .all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
