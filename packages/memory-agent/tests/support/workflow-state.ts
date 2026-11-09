import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { currentStatesSql, revisionStateSql } from "../../src/workflow/state-rows.ts";
import { sqlGet, sqlRun } from "./sql.ts";

/**
 * Records `state`, a workflow state's JSON as a released version or a test wrote it, as the
 * session's latest revision, the way `Workflows` saves one: the ledger events past the stored ones,
 * then the revision, then the session's pointer to it. Nothing decodes `state`, so a test can store
 * one only an older version wrote. Its ledger must go on from the stored one, as every saved
 * state's does.
 */
export const storeWorkflowState = Effect.fnUntraced(function* (sessionId: string, state: string) {
  expect(
    yield* sqlGet(
      `SELECT count(*) AS diverged FROM workflow_ledger_events l
       WHERE l.session_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM json_each(?2, '$.ledger') e
         WHERE e.key + 1 = l.sequence AND e.value ->> 'sequence' = l.sequence
           AND e.value ->> 'at' = l.at AND e.value ->> 'kind' = l.kind
           AND e.value ->> 'detail' = l.detail)`,
      sessionId,
      state,
    ),
  ).toEqual({ diverged: 0 });
  yield* sqlRun(
    `INSERT INTO workflow_ledger_events (session_id, sequence, at, kind, detail)
     SELECT ?1, e.value ->> 'sequence', e.value ->> 'at', e.value ->> 'kind', e.value ->> 'detail'
     FROM json_each(?2, '$.ledger') e
     WHERE e.value ->> 'sequence' > (SELECT coalesce(max(sequence), 0)
       FROM workflow_ledger_events WHERE session_id = ?1)`,
    sessionId,
    state,
  );
  yield* sqlRun(
    `INSERT INTO workflow_state_revisions
       (session_id, phase, mode, goal_json, plan_json, ledger_length, goal_version, plan_version,
        provenance, created_at, goal_instance_id)
     VALUES (?1, ?2 ->> 'phase', ?2 ->> 'mode', nullif(?2 -> '$.goal', 'null'),
       nullif(?2 -> '$.plan', 'null'),
       json_array_length(?2, '$.ledger'), ?2 ->> '$.goal.version', ?2 ->> '$.plan.version',
       'recorded', 'test',
       (SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?1))`,
    sessionId,
    state,
  );
  yield* sqlRun(
    `INSERT INTO session_workflows (session_id, revision_id, updated_at)
     VALUES (?, last_insert_rowid(), 'test')
     ON CONFLICT (session_id) DO UPDATE SET revision_id = excluded.revision_id,
       updated_at = excluded.updated_at`,
    sessionId,
  );
});

/** The session's current state as stored, as JSON text; undefined when it has none. */
export const storedWorkflowState = (sessionId: string) =>
  Effect.map(
    sqlGet(
      `SELECT ${revisionStateSql("r")} AS state FROM ${currentStatesSql} WHERE w.session_id = ?`,
      sessionId,
    ),
    (row) => row?.state,
  );
