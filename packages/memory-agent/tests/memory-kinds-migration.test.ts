import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { memoryNoteKindsMigration } from "../src/db/memory-kinds-migration.ts";
import { withTestPlatform } from "./support/platform.ts";

const version = migrations.indexOf(memoryNoteKindsMigration) + 1;

/** A database one step before the note kinds, holding nodes, an edge and a deleted node's seq. */
function oldDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrations.slice(0, version - 1).forEach((step) => db.exec(step));
  db.exec(`PRAGMA user_version = ${version - 1}`);
  db.exec(`
    INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
    INSERT INTO nodes (id, project_id, session_id, kind, text, created_at)
      VALUES ('u1', 'p', 's', 'user', 'read the config', 'old');
    INSERT INTO nodes (id, project_id, session_id, kind, text, detail, created_at)
      VALUES ('c1', 'p', 's', 'tool_call', '{"path":"a.ts"}', '{"toolCallId":"call-1"}', 'old');
    INSERT INTO nodes (id, project_id, session_id, kind, text, created_at)
      VALUES ('gone', 'p', 's', 'assistant', 'later removed', 'old');
    INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
      VALUES ('u1', 'c1', 'calls', 'structure', 0.95, 'old');
  `);
  // A deleted node's seq stays issued: the rebuilt table must not hand it out again.
  db.exec(
    "PRAGMA foreign_keys = OFF; DELETE FROM nodes WHERE id = 'gone'; PRAGMA foreign_keys = ON",
  );
  return db;
}

const scopedDatabase = Effect.fn("scopedDatabase")((open: () => DatabaseSync) =>
  Effect.acquireRelease(Effect.sync(open), (db) =>
    Effect.sync(() => {
      if (db.isOpen) db.close();
    }),
  ),
);

const schemaOf = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('nodes', 'edges') AND type IN ('index', 'trigger') ORDER BY name",
    )
    .all();

it.live("the note kinds rebuild keeps every node, edge, index, trigger and issued seq", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-kinds-migration-" });
    const db = yield* scopedDatabase(() => oldDatabase(path.join(directory, "db.sqlite")));
    const nodes = db.prepare("SELECT * FROM nodes ORDER BY seq").all();
    const edges = db.prepare("SELECT * FROM edges ORDER BY rowid").all();
    const attached = schemaOf(db);
    const issued = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'nodes'").get();

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(nodes);
    expect(db.prepare("SELECT * FROM edges ORDER BY rowid").all()).toEqual(edges);
    expect(schemaOf(db)).toEqual(attached);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'nodes'").get()).toEqual(
      issued,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Nodes stay immutable evidence.
    expect(() => db.exec("UPDATE nodes SET text = 'changed' WHERE id = 'u1'")).toThrow("immutable");

    // A note cites its evidence and supersedes an earlier note.
    db.exec(`
      INSERT INTO nodes (id, project_id, session_id, kind, text, created_at)
        VALUES ('n1', 'p', 's', 'note', 'Found: the config is in a.ts', 'new');
      INSERT INTO nodes (id, project_id, session_id, kind, text, created_at)
        VALUES ('n2', 'p', 's', 'note', 'Found: the config moved to b.ts', 'new');
      INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
        VALUES ('n1', 'c1', 'cites', 'structure', 0.9, 'new');
      INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
        VALUES ('n2', 'n1', 'supersedes', 'structure', 0.95, 'new');
    `);
    expect(db.prepare("SELECT seq FROM nodes WHERE id = 'n1'").get()?.seq).toBeGreaterThan(
      Number(issued?.seq),
    );
    expect(() =>
      db.exec(
        "INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES ('x', 'p', 's', 'memo', 'no such kind', 'new')",
      ),
    ).toThrow("CHECK");
  }).pipe(withTestPlatform),
);
