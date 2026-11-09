import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect, FileSystem, HashSet, Path } from "effect";
import { expect } from "vite-plus/test";
import { DatabaseSchemaRejectedReason, migrateDatabase } from "../src/db/database.ts";
import { goalHistoryMigration, migrations } from "../src/db/migrations.ts";
import { revisionStateSql } from "../src/workflow/state-rows.ts";
import { withTestPlatform } from "./support/platform.ts";

/** The session's first revision, and its current state that no revision held yet. */
const recorded = '{"phase":"chat","goal":null,"plan":null,"ledger":[]}';
const current =
  '{"phase":"goal","goal":null,"plan":null,"ledger":[{"sequence":1,"at":"old","kind":"phase_changed","detail":"bytes\\r\\n"}]}';

function oldDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  migrations.slice(0, goalHistoryMigration.version - 1).forEach((step) => db.exec(step));
  db.exec(`PRAGMA user_version = ${goalHistoryMigration.version - 1}`);
  db.exec(`
    INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
    INSERT INTO workflow_goal_identities VALUES ('s', 'old-goal', 'old');
    INSERT INTO session_workflows VALUES ('s', '${current}', 'old');
    INSERT INTO workflow_state_revisions (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
      VALUES (1, 's', '${recorded}', 2, 3, 'recorded', 'old', 'old-goal');
    INSERT INTO workflow_run_bindings VALUES ('run', 's', 'old-goal', 2, 3, 1, 'old');
    INSERT INTO workflow_run_events (cursor, run_id, event_key, kind, payload_json, created_at)
      VALUES (7, 'run', 'event', 'run_completed', '{"exact":"receipt\\r\\n"}', 'old');
    INSERT INTO workflow_worker_dispatches VALUES ('run', 'generation', 'old');
    INSERT INTO owner_rpc_operations VALUES ('run', 'key', 1, 'fingerprint', 1, '{"exact":"reply"}', 'uncertain');
  `);
  return db;
}
const snapshot = (
  db: DatabaseSync,
  tables: ReadonlyArray<string> = goalHistoryMigration.preservedTables,
) => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
/**
 * The preserved tables a later step keeps as they were: the run log step drops the run event
 * receipts, the ledger step keeps the workflow states as rows, and the owner ledger step keeps an
 * operation's kind and tool as columns.
 */
const rewritten = HashSet.make(
  "workflow_run_events",
  "workflow_state_revisions",
  "session_workflows",
  "owner_rpc_operations",
);
/** The fixture's operation once its fingerprint, which is not JSON, went: it names nothing. */
const operation = {
  run_id: "run",
  operation_id: 1,
  operation: null,
  tool_name: null,
  tool_call_id: null,
  side_effect: 1,
  status: "uncertain",
  outcome: null,
};
const stillKept = goalHistoryMigration.preservedTables.filter(
  (table) => !HashSet.has(rewritten, table),
);
const keptOf = <A>(rows: ReadonlyArray<A>) =>
  rows.filter(
    (_, index) => !HashSet.has(rewritten, goalHistoryMigration.preservedTables[index] ?? ""),
  );
const states = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT r.id, r.provenance, ${revisionStateSql("r")} AS state FROM workflow_state_revisions r ORDER BY r.id`,
    )
    .all();

const scopedDatabase = Effect.fn("scopedDatabase")((open: () => DatabaseSync) =>
  Effect.acquireRelease(Effect.sync(open), (db) =>
    Effect.sync(() => {
      if (db.isOpen) db.close();
    }),
  ),
);

it.live(
  "startup FK retarget preserves every revision, dispatch, RPC and old reader through reopen",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goal-history-migration-" });
      const file = path.join(directory, "db.sqlite");
      const db = yield* scopedDatabase(() => oldDatabase(file));
      const before = snapshot(db);
      yield* migrateDatabase(db);
      // Later steps drop the run event receipts, ending the run's delivery log instead, and keep
      // the workflow states and owner operations as rows and columns; every other preserved value
      // stays as it was.
      expect(snapshot(db, stillKept)).toEqual(keptOf(before));
      expect(db.prepare("SELECT * FROM owner_rpc_operations").all()).toEqual([operation]);
      // The current state no revision held becomes the latest, which the session points at.
      expect(states(db)).toEqual([
        { id: 1, provenance: "recorded", state: recorded },
        { id: 2, provenance: "legacy_current", state: current },
      ]);
      expect(db.prepare("SELECT session_id, revision_id FROM session_workflows").all()).toEqual([
        { session_id: "s", revision_id: 2 },
      ]);
      expect(db.prepare("SELECT run_id FROM workflow_run_log_closures").all()).toEqual([
        { run_id: "run" },
      ]);
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
      expect(() => db.exec("UPDATE workflow_state_revisions SET phase = 'plan'")).toThrow(
        "immutable",
      );
      expect(() => db.exec("UPDATE workflow_ledger_events SET detail = ''")).toThrow("immutable");
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
      const reopened = yield* scopedDatabase(() => new DatabaseSync(file));
      reopened.exec("PRAGMA foreign_keys = ON");
      yield* migrateDatabase(reopened);
      expect(
        reopened.prepare("SELECT * FROM workflow_goal_instances ORDER BY created_at").all(),
      ).toHaveLength(2);
      expect(reopened.prepare("SELECT * FROM workflow_run_log_entries").all()).toEqual([]);
      expect(reopened.prepare("SELECT * FROM owner_rpc_operations").all()).toEqual([operation]);
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
      expect(yield* Effect.flip(migrateDatabase(db))).toMatchObject({
        reason: DatabaseSchemaRejectedReason.cases.InvalidForeignKeys.make({}),
      });
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
