import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";

const directories: string[] = [];
function databaseFile() {
  const directory = mkdtempSync(join(tmpdir(), "memory-agent-db-"));
  directories.push(directory);
  return join(directory, "nested", "agent.db");
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const withDatabase = <A>(file: string, use: (db: Database["Type"]) => A) =>
  Effect.runPromise(
    Effect.scoped(Effect.map(Database, use)).pipe(Effect.provide(Database.layer(file))),
  );

function seed(db: Database["Type"]) {
  const now = new Date().toISOString();
  db.sqlite
    .prepare(
      "INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/work/app', 'app', ?)",
    )
    .run(now);
  db.sqlite
    .prepare(
      "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, ?)",
    )
    .run(now);
  const insert = db.sqlite.prepare(
    "INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES (?, 'p1', 's1', ?, ?, ?)",
  );
  insert.run("n1", "user", "저장소는 SQLite로 결정했다\r\n", now);
  insert.run("n2", "tool_call", '{"path":"README.md"}', now);
}

describe("Database", () => {
  test("creates the directory, applies every migration once and reopens", async () => {
    const file = databaseFile();
    await withDatabase(file, seed);
    const reopened = await withDatabase(file, (db) => ({
      version: db.sqlite.prepare("PRAGMA user_version").get(),
      nodes: db.sqlite.prepare("SELECT seq, id, text FROM nodes ORDER BY seq").all(),
    }));
    expect(reopened.version).toEqual({ user_version: migrations.length });
    // Evidence text survives byte-for-byte, CRLF included.
    expect(reopened.nodes).toEqual([
      { seq: 1, id: "n1", text: "저장소는 SQLite로 결정했다\r\n" },
      { seq: 2, id: "n2", text: '{"path":"README.md"}' },
    ]);
  });

  test("keeps nodes immutable and indexes them for trigram search", async () => {
    await withDatabase(databaseFile(), (db) => {
      seed(db);
      expect(() =>
        db.sqlite.prepare("UPDATE nodes SET text = 'changed' WHERE id = 'n1'").run(),
      ).toThrow("nodes are immutable evidence");
      const hits = db.sqlite
        .prepare(
          "SELECT n.id FROM nodes_fts f JOIN nodes n ON n.seq = f.rowid WHERE nodes_fts MATCH ?",
        )
        .all('"저장소"');
      expect(hits).toEqual([{ id: "n1" }]);
    });
  });

  test("rejects edges to unknown nodes", async () => {
    await withDatabase(databaseFile(), (db) => {
      seed(db);
      const now = new Date().toISOString();
      const edge = db.sqlite.prepare("INSERT INTO edges VALUES (?, ?, 'calls', 'structure', 1, ?)");
      edge.run("n1", "n2", now);
      expect(() => edge.run("n1", "missing", now)).toThrow();
    });
  });

  test("atomic rolls back the whole unit, including nested work", async () => {
    await withDatabase(databaseFile(), (db) => {
      seed(db);
      const count = () => db.sqlite.prepare("SELECT count(*) AS n FROM sessions").get();
      expect(() =>
        db.atomic(() => {
          db.sqlite
            .prepare(
              "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s2', 'p1', NULL, 'now')",
            )
            .run();
          db.atomic(() => {
            db.sqlite
              .prepare(
                "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s3', 'p1', NULL, 'now')",
              )
              .run();
          });
          throw new Error("abort after nested commit");
        }),
      ).toThrow("abort after nested commit");
      expect(count()).toEqual({ n: 1 });

      db.atomic(() => {
        db.sqlite
          .prepare(
            "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s4', 'p1', NULL, 'now')",
          )
          .run();
        expect(() =>
          db.atomic(() => {
            db.sqlite
              .prepare(
                "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s5', 'p1', NULL, 'now')",
              )
              .run();
            throw new Error("nested only");
          }),
        ).toThrow("nested only");
      });
      expect(db.sqlite.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
        { id: "s1" },
        { id: "s4" },
      ]);
    });
  });
});
