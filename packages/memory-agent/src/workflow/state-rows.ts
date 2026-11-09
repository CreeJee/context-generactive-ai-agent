/**
 * A workflow state is stored as rows (decisions.md "Workflow ledger는 행으로, 현재 상태는 최신
 * revision을 가리킨다 (2026-11-04)"): a revision holds its phase, Goal and Plan and how many of its
 * session's ledger events it has, and `session_workflows` names the session's latest revision.
 */

/**
 * The state a revision holds, as the JSON `decodeWorkflowState` reads. `revision` is the alias of
 * `workflow_state_revisions` in the query: an internal constant, never request input. A revision
 * saved before modes has no `mode` key, as that version wrote it (a NULL in a merge patch drops it).
 */
export const revisionStateSql = (revision: string) => `json_patch(json_object(
  'phase', ${revision}.phase,
  'goal', json(${revision}.goal_json),
  'plan', json(${revision}.plan_json),
  'ledger', (SELECT json_group_array(json_object(
      'sequence', e.sequence, 'at', e.at, 'kind', e.kind, 'detail', e.detail) ORDER BY e.sequence)
    FROM workflow_ledger_events e
    WHERE e.session_id = ${revision}.session_id AND e.sequence <= ${revision}.ledger_length)),
  json_object('mode', ${revision}.mode))`;

/**
 * The sessions' current states: `session_workflows` as `w` and its latest revision as `r`, joined
 * for a query that reads `${revisionStateSql("r")}`.
 */
export const currentStatesSql = `session_workflows w
  JOIN workflow_state_revisions r ON r.id = w.revision_id`;
