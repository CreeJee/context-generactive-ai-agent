import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { kanbanGoalOwnersMigration, migrations } from "../src/db/migrations.ts";

it.effect("a board finds its session and project through its Goal instance", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(kanbanGoalOwnersMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES
        ('p', '/test', 'test', 'old'), ('folded', '/test/.wt', 'wt', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO workflow_goal_identities VALUES ('s', 'goal', 'old');
      -- The copies named the project the session was in before an import folded it.
      INSERT INTO kanban_goals
        (goal_instance_id, session_id, project_id, project_root, mode, goal_version, hold_json,
         status, created_at, updated_at)
        VALUES ('goal', 's', 'folded', '/test/.wt', 'worktree', 2, '{"held":true}', 'active', 1, 2),
          ('lost', 's', 'p', '/test', 'sequential', 1, NULL, 'stopped', 1, 1);
      INSERT INTO kanban_goal_schedules
        (goal_instance_id, project_id, target_branch, created_at, updated_at)
        VALUES ('goal', 'folded', 'main', 1, 1);
      INSERT INTO kanban_card_attempts
        (goal_instance_id, card_id, attempt_no, session_id, goal_version, plan_version,
         created_at, updated_at)
        VALUES ('goal', 'a', 1, 'other', 2, 3, 1, 1);
    `);

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT * FROM kanban_goals").all()).toEqual([
      {
        goal_instance_id: "goal",
        project_root: "/test/.wt",
        mode: "worktree",
        goal_version: 2,
        hold_json: '{"held":true}',
        status: "active",
        created_at: 1,
        updated_at: 2,
        // Later migrations: boards started before them have woken their planner no times yet.
        planner_rounds: 0,
        planner_met: 0,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT k.goal_instance_id, s.project_id, a.card_id, g.session_id
            FROM kanban_goal_schedules k
            JOIN workflow_goal_instances g ON g.goal_instance_id = k.goal_instance_id
            JOIN sessions s ON s.id = g.session_id
            JOIN kanban_card_attempts a ON a.goal_instance_id = k.goal_instance_id`,
        )
        .all(),
    ).toEqual([{ goal_instance_id: "goal", project_id: "p", card_id: "a", session_id: "s" }]);
    expect(
      db
        .prepare(
          `SELECT name FROM pragma_table_info('kanban_goals') WHERE name IN ('session_id', 'project_id')
            UNION ALL SELECT name FROM pragma_table_info('kanban_goal_schedules') WHERE name = 'project_id'
            UNION ALL SELECT name FROM pragma_table_info('kanban_card_attempts') WHERE name = 'session_id'`,
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
