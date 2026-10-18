import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { DateTime, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database, migrateDatabase, assertDatabaseSchema } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { withTestPlatform } from "./support/platform.ts";

const databaseFile = Effect.fn("databaseFile")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-db-" });
  return path.join(directory, "nested", "agent.db");
});

/** The schema boundary itself: the connection the app's open path migrated, read directly. */
interface RawDatabase {
  readonly sqlite: DatabaseSync;
}

const withDatabase = <A>(file: string, use: (db: RawDatabase) => A) =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened: DatabaseSync[] = [];
      yield* Layer.build(
        Database.layer(file, (file) => {
          const sqlite = new DatabaseSync(file);
          opened.push(sqlite);
          return sqlite;
        }),
      );
      return use({ sqlite: opened[0]! });
    }),
  );

// Build a genuinely older schema rather than downgrading user_version on newer tables.
const withPreBindingCheckDatabase = Effect.fn("withPreBindingCheckDatabase")(function* (
  file: string,
  use: (db: RawDatabase) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  const version = migrations.findIndex((step) =>
    step.includes("CREATE TRIGGER workflow_run_bindings_owner_insert"),
  );
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const step of migrations.slice(0, version)) sqlite.exec(step);
    sqlite.exec(`PRAGMA user_version = ${version}`);
    use({ sqlite });
  } finally {
    sqlite.close();
  }
}, Effect.scoped);

function seed(db: RawDatabase) {
  const now = DateTime.formatIso(DateTime.nowUnsafe());
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
  it("rolls back the entire pending migration path and restores FK enforcement when a later step fails", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const step of migrations.slice(0, 47)) sqlite.exec(step);
      sqlite.exec("PRAGMA user_version=47; CREATE TABLE owner_read_recoveries(existing_data TEXT)");
      seed({ sqlite });
      const before = sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all();
      expect(() => migrateDatabase(sqlite)).toThrow(/already exists/);
      expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 47 });
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_schema WHERE name='owner_workflow_executions'")
          .get(),
      ).toBeUndefined();
      expect(sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(before);
      expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("readers require the actual current DB contract and reject stale, newer or damaged schemas before execution", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      expect(() => assertDatabaseSchema(sqlite)).toThrow(/owning app/);
      migrateDatabase(sqlite);
      expect(assertDatabaseSchema(sqlite)).toBe(migrations.length);
      sqlite.exec(`PRAGMA user_version=${migrations.length + 1}`);
      expect(() => assertDatabaseSchema(sqlite)).toThrow(/update the app/);
      sqlite.exec(
        `PRAGMA user_version=${migrations.length}; ALTER TABLE owner_read_recoveries RENAME TO missing_receipts`,
      );
      expect(() => assertDatabaseSchema(sqlite)).toThrow(/owner_read_recoveries/);
    } finally {
      sqlite.close();
    }
  });

  it("adds recovery receipts to schema 48 without changing evidence and leaves 48 intact on a failed upgrade", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const step of migrations.slice(0, 48)) sqlite.exec(step);
      sqlite.exec("PRAGMA user_version=48");
      seed({ sqlite });
      const before = sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all();
      sqlite.exec("PRAGMA query_only=ON");
      expect(() => migrateDatabase(sqlite)).toThrow(/readonly|read-only/i);
      expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 48 });
      expect(
        sqlite.prepare("SELECT name FROM sqlite_schema WHERE name='owner_read_recoveries'").get(),
      ).toBeUndefined();
      expect(sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(before);
      sqlite.exec("PRAGMA query_only=OFF");
      migrateDatabase(sqlite);
      expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({
        user_version: migrations.length,
      });
      expect(sqlite.prepare("SELECT * FROM nodes ORDER BY seq").all()).toEqual(before);
      expect(sqlite.prepare("SELECT count(*) AS n FROM owner_read_recoveries").get()).toEqual({
        n: 0,
      });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      sqlite.close();
    }
  });

  it.live("creates the directory, applies every migration once and reopens", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile();
      yield* withDatabase(file, seed);
      const reopened = yield* withDatabase(file, (db) => ({
        version: db.sqlite.prepare("PRAGMA user_version").get(),
        nodes: db.sqlite.prepare("SELECT seq, id, text FROM nodes ORDER BY seq").all(),
      }));
      expect(reopened.version).toEqual({ user_version: migrations.length });
      // Evidence text survives byte-for-byte, CRLF included.
      expect(reopened.nodes).toEqual([
        { seq: 1, id: "n1", text: "저장소는 SQLite로 결정했다\r\n" },
        { seq: 2, id: "n2", text: '{"path":"README.md"}' },
      ]);
    }).pipe(withTestPlatform),
  );

  it.live(
    "upgrades the 0.0.13 released schema without changing evidence or inventing execution pins",
    () =>
      Effect.gen(function* () {
        // 0.0.13/eeb88ce has 30 migrations; its complete prefix was compared with this tree.
        const releasedVersion = 30;
        const file = yield* databaseFile();
        yield* (yield* FileSystem.FileSystem).makeDirectory((yield* Path.Path).dirname(file), {
          recursive: true,
        });
        const old = new DatabaseSync(file);
        const state = '{"goal":{"version":4},"plan":{"version":7}}';
        try {
          old.exec("PRAGMA foreign_keys = ON");
          for (const step of migrations.slice(0, releasedVersion)) old.exec(step);
          old.exec(`PRAGMA user_version = ${releasedVersion}`);
          seed({ sqlite: old });
          old.prepare("INSERT INTO session_workflows VALUES ('s1', ?, 'released')").run(state);
        } finally {
          old.close();
        }
        const read = () =>
          withDatabase(file, (db) => ({
            version: db.sqlite.prepare("PRAGMA user_version").get(),
            nodes: db.sqlite.prepare("SELECT seq, id, text FROM nodes ORDER BY seq").all(),
            state: db.sqlite.prepare("SELECT state_json FROM session_workflows").get(),
            revisions: db.sqlite
              .prepare(
                "SELECT state_json, goal_version, plan_version, provenance, goal_instance_id FROM workflow_state_revisions",
              )
              .all(),
            executionPins: db.sqlite
              .prepare("SELECT * FROM workflow_goal_worker_generations")
              .all(),
            dispatches: db.sqlite.prepare("SELECT * FROM workflow_worker_dispatches").all(),
          }));
        const upgraded = yield* read();
        expect(upgraded).toEqual({
          version: { user_version: migrations.length },
          nodes: [
            { seq: 1, id: "n1", text: "저장소는 SQLite로 결정했다\r\n" },
            { seq: 2, id: "n2", text: '{"path":"README.md"}' },
          ],
          state: { state_json: state },
          revisions: [
            {
              state_json: state,
              goal_version: 4,
              plan_version: 7,
              provenance: "legacy_current",
              goal_instance_id: null,
            },
          ],
          executionPins: [],
          dispatches: [],
        });
        expect(yield* read()).toEqual(upgraded);
      }).pipe(withTestPlatform),
  );

  it.live(
    "rejects inconsistent existing Goal/run bindings without upgrading or deleting evidence",
    () =>
      Effect.gen(function* () {
        const file = yield* databaseFile();
        yield* withPreBindingCheckDatabase(file, (db) => {
          seed(db);
          const now = DateTime.formatIso(DateTime.nowUnsafe());
          db.sqlite
            .prepare(
              "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s2', 'p1', NULL, ?)",
            )
            .run(now);
          db.sqlite
            .prepare("INSERT INTO workflow_goal_identities VALUES ('s1', 'goal-s1', ?)")
            .run(now);
          const revision = db.sqlite
            .prepare(`
          INSERT INTO workflow_state_revisions
            (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
          VALUES ('s1', '{}', 1, NULL, 'recorded', ?, 'goal-s1')
        `)
            .run(now).lastInsertRowid;
          // Simulate a database written by the previous schema, which had no tuple check.
          db.sqlite.exec(`
        PRAGMA user_version = ${migrations.findIndex((step) => step.includes("CREATE TRIGGER workflow_run_bindings_owner_insert"))};
      `);
          db.sqlite
            .prepare(`
          INSERT INTO workflow_run_bindings
            (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
          VALUES ('forged', 's2', 'goal-s1', 1, NULL, ?, ?)
        `)
            .run(revision, now);
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              withDatabase(file, (db) => db.sqlite.prepare("PRAGMA user_version").get()),
            ),
          ),
        ).toBe(true);
        const old = new DatabaseSync(file);
        try {
          expect(old.prepare("PRAGMA user_version").get()).toEqual({
            user_version: migrations.findIndex((step) =>
              step.includes("CREATE TRIGGER workflow_run_bindings_owner_insert"),
            ),
          });
          expect(old.prepare("SELECT run_id FROM workflow_run_bindings").all()).toEqual([
            { run_id: "forged" },
          ]);
          expect(
            old
              .prepare(
                "SELECT name FROM sqlite_master WHERE name = 'workflow_run_bindings_owner_insert'",
              )
              .get(),
          ).toBeUndefined();
        } finally {
          old.close();
        }
      }).pipe(withTestPlatform),
  );

  it.live("upgrades valid earlier bindings and keeps their run receipts byte-for-byte", () =>
    Effect.gen(function* () {
      const file = yield* databaseFile();
      yield* withPreBindingCheckDatabase(file, (db) => {
        seed(db);
        const now = DateTime.formatIso(DateTime.nowUnsafe());
        db.sqlite
          .prepare("INSERT INTO workflow_goal_identities VALUES ('s1', 'goal-s1', ?)")
          .run(now);
        const revision = db.sqlite
          .prepare(`
          INSERT INTO workflow_state_revisions
            (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
          VALUES ('s1', '{}', 1, NULL, 'recorded', ?, 'goal-s1')
        `)
          .run(now).lastInsertRowid;
        db.sqlite.exec(`
        PRAGMA user_version = ${migrations.findIndex((step) => step.includes("CREATE TRIGGER workflow_run_bindings_owner_insert"))};
      `);
        db.sqlite
          .prepare(`
          INSERT INTO workflow_run_bindings
            (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
          VALUES ('old-run', 's1', 'goal-s1', 1, NULL, ?, ?)
        `)
          .run(revision, now);
        db.sqlite
          .prepare(`
          INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at)
          VALUES ('old-run', 'chunk:0', 'chunk', ?, ?)
        `)
          .run('{"text":"kept"}', now);
      });
      const reopened = yield* withDatabase(file, (db) => ({
        version: db.sqlite.prepare("PRAGMA user_version").get(),
        bindings: db.sqlite
          .prepare("SELECT run_id, session_id, goal_version FROM workflow_run_bindings")
          .all(),
        receipts: db.sqlite.prepare("SELECT run_id, payload_json FROM workflow_run_events").all(),
      }));
      expect(reopened).toEqual({
        version: { user_version: migrations.length },
        bindings: [{ run_id: "old-run", session_id: "s1", goal_version: 1 }],
        receipts: [{ run_id: "old-run", payload_json: '{"text":"kept"}' }],
      });
    }).pipe(withTestPlatform),
  );

  it.live("keeps nodes immutable and indexes them for trigram search", () =>
    Effect.gen(function* () {
      yield* withDatabase(yield* databaseFile(), (db) => {
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
    }).pipe(withTestPlatform),
  );

  it.live("rejects edges to unknown nodes", () =>
    Effect.gen(function* () {
      yield* withDatabase(yield* databaseFile(), (db) => {
        seed(db);
        const now = DateTime.formatIso(DateTime.nowUnsafe());
        const edge = db.sqlite.prepare(
          "INSERT INTO edges VALUES (?, ?, 'calls', 'structure', 1, ?)",
        );
        edge.run("n1", "n2", now);
        expect(() => edge.run("n1", "missing", now)).toThrow();
      });
    }).pipe(withTestPlatform),
  );
});
