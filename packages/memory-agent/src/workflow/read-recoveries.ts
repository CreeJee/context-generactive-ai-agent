/** The only policy a read recovery receipt was ever written with. */
const policy = "background-result-read-v1";

/**
 * Whether a run's uncertain read was recovered by an operator receipt (decisions.md "검증된
 * background 읽기 실패의 명시적 복구 (2026-10-11)"). Receipts are no longer written; ones a released
 * version wrote still resolve admission. A receipt never makes the original failed run usable for
 * replay or completion evidence. SQL aliases are internal constants, never request input.
 */
export const recoveredReadRunSql = (run: "r" | "recovery_run") => `EXISTS (
  SELECT 1 FROM owner_read_recoveries rr
  JOIN owner_rpc_operations ro ON ro.run_id = rr.run_id AND ro.operation_id = rr.operation_id
  JOIN owner_rpc_operations ra ON ra.run_id = rr.run_id AND ra.operation_id = rr.operation_id - 1
  JOIN workflow_run_bindings rb ON rb.run_id = rr.run_id
  JOIN owner_workflow_executions re ON re.execution_id = rr.execution_id
  WHERE rr.run_id = ${run}.run_id AND rr.session_id = ${run}.thread_id
    AND ${run}.status = 'failed' AND ${run}.error_code = 'worker_execution_failed'
    AND ${run}.finished_at = rr.finished_at
    AND rr.policy = '${policy}' AND ro.status = 'uncertain' AND ro.side_effect = 1
    AND ro.fingerprint = rr.operation_fingerprint AND ro.run_key = rr.run_key
    AND ra.status = 'succeeded' AND ra.side_effect = 1 AND ra.run_key = rr.run_key
    AND ra.fingerprint = rr.authorization_fingerprint
    AND rb.session_id = rr.session_id AND rb.goal_instance_id = rr.goal_instance_id
    AND rb.workflow_revision_id = rr.workflow_revision_id
    AND re.workflow_name = 'GoalExecution' AND re.status = 'completed'
    AND re.result_json = rr.execution_result_json AND re.payload_json = rr.execution_payload_json
    AND NOT EXISTS (SELECT 1 FROM workflow_run_events revoked
      WHERE revoked.run_id=rr.run_id AND revoked.event_key='operator:read-recovery:revoke:' || rr.receipt_id)
    AND NOT EXISTS (SELECT 1 FROM owner_rpc_operations later
      WHERE later.run_id = rr.run_id AND later.operation_id > rr.operation_id)
    AND NOT EXISTS (SELECT 1 FROM owner_rpc_operations other
      WHERE other.run_id = rr.run_id AND other.operation_id <> rr.operation_id AND other.status <> 'succeeded')
)`;
