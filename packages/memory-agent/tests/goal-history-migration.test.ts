import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { expect } from "vite-plus/test";
import { DatabaseSchemaRejectedReason, migrateDatabase } from "../src/db/database.ts";
import { goalHistoryMigration, migrations } from "../src/db/migrations.ts";
import { withTestPlatform } from "./support/platform.ts";

function oldDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const step of migrations.slice(0, goalHistoryMigration.version - 1)) db.exec(step);
  db.exec(`PRAGMA user_version = ${goalHistoryMigration.version - 1}`);
  db.exec(`
    INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
    INSERT INTO workflow_goal_identities VALUES ('s', 'old-goal', 'old');
    INSERT INTO session_workflows VALUES ('s', '{"unchanged":"bytes\\r\\n"}', 'old');
    INSERT INTO workflow_state_revisions (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
      VALUES (1, 's', '{"exact":"old"}', 2, 3, 'recorded', 'old', 'old-goal');
    INSERT INTO workflow_run_bindings VALUES ('run', 's', 'old-goal', 2, 3, 1, 'old');
    INSERT INTO workflow_run_events (cursor, run_id, event_key, kind, payload_json, created_at)
      VALUES (7, 'run', 'event', 'run_completed', '{"exact":"receipt\\r\\n"}', 'old');
    INSERT INTO workflow_worker_dispatches VALUES ('run', 'generation', 'old');
    INSERT INTO owner_rpc_operations VALUES ('run', 'key', 1, 'fingerprint', 1, '{"exact":"reply"}', 'uncertain');
  `);
  return db;
}
const snapshot = (db: DatabaseSync) =>
  goalHistoryMigration.preservedTables.map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );

const scopedDatabase = Effect.fn("scopedDatabase")((open: () => DatabaseSync) =>
  Effect.acquireRelease(Effect.sync(open), (db) =>
    Effect.sync(() => {
      if (db.isOpen) db.close();
    }),
  ),
);

it.live(
  "startup FK retarget preserves every revision, event cursor, dispatch, RPC and old reader through reopen",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-history-migration-" });
      const file = path.join(directory, "db.sqlite");
      let db = yield* scopedDatabase(() => oldDatabase(file));
      const before = snapshot(db);
      migrateDatabase(db);
      // Later steps only add the nullable board author; every preserved value stays as it was.
      expect(
        snapshot(db).map((rows) => rows.map(({ author_json: _author, ...row }) => row)),
      ).toEqual(before);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db
          .prepare("PRAGMA foreign_key_list(workflow_run_bindings)")
          .all()
          .some((row) => row.table === "workflow_goal_instances"),
      ).toBe(true);
      expect(() => db.exec("UPDATE workflow_run_bindings SET goal_version = 9")).toThrow(
        "immutable",
      );
      expect(() => db.exec("UPDATE workflow_worker_dispatches SET generation = 'new'")).toThrow(
        "immutable",
      );
      expect(() => db.exec("UPDATE workflow_run_events SET payload_json = '{}' ")).toThrow(
        "immutable",
      );
      expect(() => db.exec("UPDATE workflow_state_revisions SET state_json = '{}' ")).toThrow();
      db.exec(
        "INSERT INTO workflow_goal_instances VALUES ('new-goal', 's', 'new'); UPDATE workflow_goal_identities SET goal_instance_id = 'new-goal', created_at = 'new' WHERE session_id = 's'",
      );
      expect(
        db
          .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = 's'")
          .all(),
      ).toEqual([{ goal_instance_id: "new-goal" }]);
      expect(db.prepare("SELECT goal_instance_id FROM workflow_run_bindings").all()).toEqual([
        { goal_instance_id: "old-goal" },
      ]);
      expect(() =>
        db.exec(
          "INSERT INTO workflow_run_bindings VALUES ('forged', 's', 'old-goal', 2, 3, 1, 'new')",
        ),
      ).toThrow("session mismatch");
      db.close();
      db = yield* scopedDatabase(() => new DatabaseSync(file));
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(db);
      expect(
        db.prepare("SELECT * FROM workflow_goal_instances ORDER BY created_at").all(),
      ).toHaveLength(2);
      expect(db.prepare("SELECT * FROM workflow_run_events").all()).toEqual(before[4]);
      expect(db.prepare("SELECT * FROM owner_rpc_operations").all()).toEqual(before[6]);
    }).pipe(withTestPlatform),
);

it.live(
  "corrupt historical reference rolls back rebuild and version, restores FK enforcement without deleting receipts",
  () =>
    Effect.gen(function* () {
      const db = yield* scopedDatabase(() => oldDatabase(":memory:"));
      db.exec(
        "PRAGMA foreign_keys = OFF; DROP TRIGGER workflow_run_bindings_no_update; UPDATE workflow_run_bindings SET goal_instance_id = 'missing'; PRAGMA foreign_keys = ON",
      );
      const before = snapshot(db);
      expect(() => migrateDatabase(db)).toThrow(
        expect.objectContaining({
          reason: DatabaseSchemaRejectedReason.cases.InvalidForeignKeys.make({}),
        }),
      );
      expect(snapshot(db)).toEqual(before);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: goalHistoryMigration.version - 1,
      });
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'workflow_goal_instances'").get(),
      ).toBeUndefined();
      expect(() =>
        db.exec("INSERT INTO workflow_worker_dispatches VALUES ('missing-run', 'new', 'new')"),
      ).toThrow("FOREIGN KEY");
      expect(
        db
          .prepare("PRAGMA foreign_key_list(workflow_run_bindings)")
          .all()
          .some((row) => row.table === "workflow_goal_identities"),
      ).toBe(true);
    }),
);
