import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { executionSubjectsMigration, migrations } from "../src/db/migrations.ts";

/** A Goal execution's payload for run `run` of session `s`, bound to Goal `g` at `revision`. */
const goalPayload = (run: string, revision: number) =>
  `json_object('_tag', 'GoalExecutionPayload', 'identity', json_object(
    'owner', json_object('ownerId', 'o', 'generation', '1'), 'sessionId', 's', 'runId', '${run}',
    'goalInstanceId', 'g', 'workflowRevisionId', ${revision}))`;
const cardElement = (card: string, attempt: number) =>
  `json_object('token', 't', 'payload', json_object('sessionId', 's', 'goalInstanceId', 'g',
    'cardId', '${card}', 'attemptNo', ${attempt}, 'goalVersion', 1, 'planVersion', 1,
    'notes', json_array()))`;

it.effect(
  "an execution's session and Goal run, and a card attempt's item, move to app tables",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (db) => Effect.sync(() => db.close()),
      );
      const index = migrations.indexOf(executionSubjectsMigration);
      migrations.slice(0, index).forEach((step) => db.exec(step));
      db.exec(`PRAGMA user_version = ${index}`);
      db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO workflow_goal_identities VALUES ('s', 'g', 'old');
      INSERT INTO workflow_state_revisions
        (id, session_id, goal_version, plan_version, provenance, created_at, goal_instance_id)
        VALUES (1, 's', 1, NULL, 'recorded', 'old', 'g');
      INSERT INTO workflow_run_bindings VALUES
        ('run', 's', 'g', 1, NULL, 1, 'old'), ('other', 's', 'g', 1, NULL, 1, 'old');
      INSERT INTO owner_workflow_executions (execution_id, workflow_name, payload_json, status)
        VALUES
        ('goal', 'GoalExecution', ${goalPayload("run", 1)}, 'completed'),
        -- Its identity names another revision than its run's binding: evidence never matched it.
        ('stray', 'GoalExecution', ${goalPayload("other", 2)}, 'completed'),
        ('decision', 'HumanDecisionExecution',
          json_object('sessionId', 's', 'goalInstanceId', 'g', 'cardId', 'c', 'key', 'k'), 'running'),
        ('nobody', 'SomeWorkflow', '{}', 'completed');
      INSERT INTO kanban_card_attempts
        (goal_instance_id, card_id, attempt_no, session_id, goal_version, plan_version, handled,
         created_at, updated_at)
        VALUES ('g', 'c', 1, 's', 1, 1, 1, 0, 0), ('g', 'c', 2, 's', 1, 1, 0, 0, 0),
          ('g', 'd', 1, 's', 1, 1, 0, 0, 0);
      INSERT INTO persisted_queue_items
        (queue_name, id, element_json, state, attempts, visible_at, created_at, updated_at)
        VALUES ('DurableQueue/KanbanCard', 'item-c1', ${cardElement("c", 1)}, 'completed', 1, 0, 0, 0),
          ('DurableQueue/KanbanCard', 'item-c2', ${cardElement("c", 2)}, 'failed', 3, 0, 0, 0),
          ('DurableQueue/KanbanCard', 'broken', 'not json', 'failed', 3, 0, 0, 0);
    `);

      yield* migrateDatabase(db);

      expect(
        db.prepare("SELECT * FROM workflow_execution_subjects ORDER BY execution_id").all(),
      ).toEqual([
        { execution_id: "decision", session_id: "s", run_id: null },
        { execution_id: "goal", session_id: "s", run_id: "run" },
        { execution_id: "stray", session_id: "s", run_id: null },
      ]);
      expect(
        db
          .prepare(
            "SELECT card_id, attempt_no, queue_item_id FROM kanban_card_attempts ORDER BY card_id, attempt_no",
          )
          .all(),
      ).toEqual([
        { card_id: "c", attempt_no: 1, queue_item_id: "item-c1" },
        { card_id: "c", attempt_no: 2, queue_item_id: "item-c2" },
        { card_id: "d", attempt_no: 1, queue_item_id: null },
      ]);
    }),
);
