import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { memoryCandidateDecisionsMigration, migrations } from "../src/db/migrations.ts";

it.effect("a memory promotion's decision and candidate become one row", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (db) => Effect.sync(() => db.close()),
    );
    const index = migrations.indexOf(memoryCandidateDecisionsMigration);
    migrations.slice(0, index).forEach((step) => db.exec(step));
    db.exec(`PRAGMA user_version = ${index}`);
    db.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'old');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'old');
      INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES
        ('turn', 'p', 's', 'user', 'remember it', 'old'),
        ('memory', 'p', NULL, 'topic', 'kept fact', 'old');
      INSERT INTO work_tasks
        (id, project_id, parent_run_id, parent_tool_call_id, agent_name, status, title, request,
         created_at, updated_at)
        VALUES ('task', 'p', 'parent', 'call', 'helper', 'completed', 'Task', 'Do it', 1, 1);
      INSERT INTO agent_invocations
        (id, task_id, parent_run_id, parent_tool_call_id, kind, status, message,
         idempotency_key, created_at)
        VALUES ('start', 'task', 'parent', 'call', 'start', 'completed', 'Do it', 'start:call', 1);
      INSERT INTO agent_run_attempts
        (id, task_id, invocation_id, attempt_number, chat_run_id, thread_id, status,
         created_at, updated_at)
        VALUES ('attempt', 'task', 'start', 1, 'run', 'thread', 'completed', 1, 1);
      INSERT INTO final_answer_claims
        (id, project_id, origin_session_id, parent_run_id, parent_message_id, created_at)
        VALUES ('claim', 'p', 's', 'parent', 'answer', 1);
      INSERT INTO knowledge_decisions
        (id, project_id, task_id, attempt_id, claim_id, origin_session_id,
         authorized_by_user_node_id, authorized_by_user_node_id_snapshot, text, status, created_at)
        VALUES ('saved', 'p', 'task', 'attempt', 'claim', 's', 'turn', 'turn', 'kept fact',
            'edited_saved', 5),
          ('declined', 'p', 'task', 'attempt', 'claim', 's', NULL, 'gone', 'not this',
            'rejected', 6);
      INSERT INTO memory_candidates
        (id, decision_id, project_id, proposed_text, resolved_text, disposition, memory_node_id,
         created_at)
        VALUES ('kept', 'saved', 'p', 'a fact', 'kept fact', 'edited_saved', 'memory', 5),
          ('refused', 'declined', 'p', 'not this', 'not this', 'rejected', NULL, 6);
      INSERT INTO memory_candidate_evidence (candidate_id, evidence_ref_id_snapshot)
        VALUES ('kept', 'ref');
      INSERT INTO memory_usage_events
        (id, project_id, candidate_id, memory_node_id, parent_run_id, kind, created_at)
        VALUES ('use', 'p', 'kept', 'memory', 'later', 'retrieved', 7);
      -- A damaged file: a candidate whose decision is gone, with its evidence and usage.
      PRAGMA foreign_keys = OFF;
      INSERT INTO memory_candidates
        (id, decision_id, project_id, proposed_text, resolved_text, disposition, memory_node_id,
         created_at)
        VALUES ('stray', 'missing', 'p', 'lost', 'lost', 'conversation_only', NULL, 8);
      INSERT INTO memory_candidate_evidence (candidate_id, evidence_ref_id_snapshot)
        VALUES ('stray', 'ref');
      INSERT INTO memory_usage_events
        (id, project_id, candidate_id, memory_node_id, parent_run_id, kind, created_at)
        VALUES ('stray-use', 'p', 'stray', 'memory', 'later', 'retrieved', 9);
      PRAGMA foreign_keys = ON;
    `);

    yield* migrateDatabase(db);

    expect(db.prepare("SELECT * FROM memory_candidates ORDER BY created_at").all()).toEqual([
      {
        id: "kept",
        project_id: "p",
        task_id: "task",
        attempt_id: "attempt",
        claim_id: "claim",
        origin_session_id: "s",
        authorized_by_user_node_id: "turn",
        authorized_by_user_node_id_snapshot: "turn",
        proposed_text: "a fact",
        resolved_text: "kept fact",
        disposition: "edited_saved",
        memory_node_id: "memory",
        created_at: 5,
      },
      {
        id: "refused",
        project_id: "p",
        task_id: "task",
        attempt_id: "attempt",
        claim_id: "claim",
        origin_session_id: "s",
        authorized_by_user_node_id: null,
        authorized_by_user_node_id_snapshot: "gone",
        proposed_text: "not this",
        resolved_text: "not this",
        disposition: "rejected",
        memory_node_id: null,
        created_at: 6,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT candidate_id FROM memory_candidate_evidence UNION ALL SELECT candidate_id FROM memory_usage_events",
        )
        .all(),
    ).toEqual([{ candidate_id: "kept" }, { candidate_id: "kept" }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'knowledge_decisions'").all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }),
);
