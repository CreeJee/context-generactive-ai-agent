import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

const withDatabase = <A>(file: string, use: (db: Database["Service"]) => A) =>
  Effect.runPromise(
    Effect.scoped(Effect.map(Database, use)).pipe(Effect.provide(Database.layer(file))),
  );

// Build a genuinely older schema rather than downgrading user_version on newer tables.
function withPreBindingCheckDatabase(file: string, use: (db: Database["Service"]) => void) {
  mkdirSync(join(file, ".."), { recursive: true });
  const sqlite = new DatabaseSync(file);
  const version = migrations.findIndex((step) =>
    step.includes("CREATE TRIGGER workflow_run_bindings_owner_insert"),
  );
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const step of migrations.slice(0, version)) sqlite.exec(step);
    sqlite.exec(`PRAGMA user_version = ${version}`);
    use({ sqlite, atomic: (work) => work() });
  } finally {
    sqlite.close();
  }
}

function seed(db: Database["Service"]) {
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

  test("upgrades the 0.0.13 released schema without changing evidence or inventing execution pins", async () => {
    // 0.0.13/eeb88ce has 30 migrations; its complete prefix was compared with this tree.
    const releasedVersion = 30;
    const file = databaseFile();
    mkdirSync(join(file, ".."), { recursive: true });
    const old = new DatabaseSync(file);
    const state = '{"goal":{"version":4},"plan":{"version":7}}';
    try {
      old.exec("PRAGMA foreign_keys = ON");
      for (const step of migrations.slice(0, releasedVersion)) old.exec(step);
      old.exec(`PRAGMA user_version = ${releasedVersion}`);
      seed({ sqlite: old, atomic: (work) => work() });
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
        executionPins: db.sqlite.prepare("SELECT * FROM workflow_goal_worker_generations").all(),
        dispatches: db.sqlite.prepare("SELECT * FROM workflow_worker_dispatches").all(),
      }));
    const upgraded = await read();
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
    expect(await read()).toEqual(upgraded);
  });

  test("rejects inconsistent existing Goal/run bindings without upgrading or deleting evidence", async () => {
    const file = databaseFile();
    withPreBindingCheckDatabase(file, (db) => {
      seed(db);
      const now = new Date().toISOString();
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
    await expect(
      withDatabase(file, (db) => db.sqlite.prepare("PRAGMA user_version").get()),
    ).rejects.toThrow();
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
  });

  test("upgrades valid earlier bindings and keeps their run receipts byte-for-byte", async () => {
    const file = databaseFile();
    withPreBindingCheckDatabase(file, (db) => {
      seed(db);
      const now = new Date().toISOString();
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
    const reopened = await withDatabase(file, (db) => ({
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
