import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { migrations, sessionStateTablesMigration } from "../src/db/migrations.ts";

const block = (end: number | string, node: number | string = "'n'") =>
  `json_object('end', ${end}, 'nextTurnNodeId', ${node}, 'text', 'summary to ${end}')`;

it.effect("what tasks and sessions kept in chat_metadata moves to tables of their own", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(sessionStateTablesMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES
        ('running', 'p', 'old'), ('blocked', 'p', 'old'), ('stopped', 'p', 'old'),
        ('broken', 'p', 'old'), ('retrying', 'p', 'old');
      INSERT INTO work_tasks
        (id, project_id, parent_run_id, parent_tool_call_id, agent_name, status, title, request,
         created_at, updated_at)
        VALUES ('task', 'p', 'parent', 'call', 'background_shell', 'failed', 'Task', 'Do it', 1, 1),
          ('odd', 'p', 'parent', 'call', 'background_shell', 'failed', 'Task', 'Do it', 1, 1);
      INSERT INTO chat_metadata (namespace, key, value) VALUES
        -- A task's saved status stays what it was, even where its attempt ended otherwise.
        ('background-task-result', 'task', json_object('status', 'completed', 'result', 'out')),
        ('background-task-result', 'odd', json_object('status', 'paused', 'result', 'out')),
        ('background-task-result', 'deleted-task', json_object('status', 'completed', 'result', 'x')),
        ('memory-agent/workflow-execution', 'running', json_object('_tag', 'running', 'runId', 'r1',
          'goalVersion', 2, 'planVersion', 3, 'noProgressRuns', 1, 'progress', json_object(
            'completedSteps', json_array('a', 'b'), 'evidence', json_array('e', 5),
            'toolResults', json_array('t')))),
        ('memory-agent/workflow-execution', 'blocked', json_object('_tag', 'blocked', 'runId', 'r2',
          'reason', 'permission', 'detail', 'why', 'evidence', json_array('x', 'y'))),
        -- A field of another case was never read.
        ('memory-agent/workflow-execution', 'stopped',
          json_object('_tag', 'stopped', 'reason', 'user', 'runId', 'stale')),
        ('memory-agent/workflow-execution', 'broken',
          json_object('_tag', 'running', 'runId', 'r3', 'planVersion', 1, 'noProgressRuns', 0)),
        ('memory-agent/workflow-execution', 'retrying', json_object('_tag', 'retrying',
          'runId', 'r4', 'goalVersion', 1, 'planVersion', 1, 'noProgressRuns', 0,
          'progress', json_object('completedSteps', json_array(), 'evidence', json_array()),
          'retryAt', 12.5)),
        ('memory-agent/workflow-execution', 'deleted', json_object('_tag', 'stopped', 'reason', 'user')),
        -- Blocks line up to the first whose end is not a whole turn.
        ('memory-agent/turn-summaries', 'running', json_object('blocks',
          json_array(json(${block(4)}), json(${block(8)}), json(${block(9.5)}), json(${block(12)})))),
        -- One block that does not decode left the session with none.
        ('memory-agent/turn-summaries', 'blocked', json_object('blocks',
          json_array(json(${block(4)}), json(${block(8, 3)})))),
        ('memory-agent/turn-summaries', 'stopped', json_object('blocks', 'none')),
        ('memory-agent/turn-summaries', 'deleted', json_object('blocks', json_array(json(${block(4)})))),
        ('memory-agent/context-usage', 'running', json_object('inputTokens', 1)),
        ('memory-agent/context-usage', 'deleted', json_object('inputTokens', 1)),
        ('other', 'deleted', json_object());
    `);

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT * FROM background_task_results").all()).toEqual([
      { task_id: "task", status: "completed", result: "out" },
    ]);
    const none = {
      run_id: null,
      goal_version: null,
      plan_version: null,
      no_progress_runs: null,
      retry_at: null,
      reason: null,
      detail: null,
    };
    expect(db.prepare("SELECT * FROM workflow_executions ORDER BY session_id").all()).toEqual([
      {
        ...none,
        session_id: "blocked",
        state: "blocked",
        run_id: "r2",
        reason: "permission",
        detail: "why",
      },
      {
        ...none,
        session_id: "retrying",
        state: "retrying",
        run_id: "r4",
        goal_version: 1,
        plan_version: 1,
        no_progress_runs: 0,
        retry_at: 12.5,
      },
      {
        ...none,
        session_id: "running",
        state: "running",
        run_id: "r1",
        goal_version: 2,
        plan_version: 3,
        no_progress_runs: 1,
      },
      { ...none, session_id: "stopped", state: "stopped", reason: "user" },
    ]);
    expect(
      db
        .prepare(
          "SELECT session_id, list, position, value FROM workflow_execution_entries ORDER BY session_id, list, position",
        )
        .all(),
    ).toEqual([
      { session_id: "blocked", list: "blocker_evidence", position: 0, value: "x" },
      { session_id: "blocked", list: "blocker_evidence", position: 1, value: "y" },
      { session_id: "running", list: "completed_step", position: 0, value: "a" },
      { session_id: "running", list: "completed_step", position: 1, value: "b" },
      { session_id: "running", list: "progress_evidence", position: 0, value: "e" },
      { session_id: "running", list: "tool_result", position: 0, value: "t" },
    ]);
    expect(
      db
        .prepare(
          "SELECT session_id, position, turn_end, next_turn_node_id FROM turn_summary_blocks ORDER BY session_id, position",
        )
        .all(),
    ).toEqual([
      { session_id: "running", position: 0, turn_end: 4, next_turn_node_id: "n" },
      { session_id: "running", position: 1, turn_end: 8, next_turn_node_id: "n" },
    ]);
    expect(
      db.prepare("SELECT namespace, key FROM chat_metadata ORDER BY namespace, key").all(),
    ).toEqual([
      { namespace: "memory-agent/context-usage", key: "running" },
      { namespace: "other", key: "deleted" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
