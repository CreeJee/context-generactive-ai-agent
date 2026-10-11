import { sha256, randomUUID } from "../runtime/synchronous-crypto.ts";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { Database } from "../db/database.ts";
import { decodeFullLoopValue } from "./full-loop-codec.ts";
import { GoalExecutionPayload } from "../workflow/goal-execution-contracts.ts";
import { workflowRunEvents } from "../workflow/run-events.ts";

const policy = "background-result-read-v1";
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
export const ReadRecoveryConfirmation = Schema.Struct({
  assessmentId: Digest,
  confirmation: Schema.Literal("confirm_read_only_and_continue_without_replay"),
  backup: Schema.Struct({
    reference: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
    verification: Schema.Literals([
      "operator_verified_consistent_restore",
      "operator_verified_original_records",
    ]),
  }),
});
export type ReadRecoveryConfirmation = typeof ReadRecoveryConfirmation.Type;
export const ReadRecoveryRevocation = Schema.Struct({
  confirmation: Schema.Literal("revoke_read_recovery_without_replay"),
  receiptId: Schema.NonEmptyString,
});
export type ReadRecoveryRevocation = typeof ReadRecoveryRevocation.Type;

export class ReadRecoveryStorageError extends Schema.TaggedError<ReadRecoveryStorageError>()(
  "ReadRecoveryStorageError",
  { phase: Schema.Literals(["read", "write"]), cause: Schema.Unknown },
) {}

/** SQL aliases are internal constants, never request input. A receipt resolves admission only;
 * the original failed run and uncertain RPC remain unusable for replay or completion evidence. */
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

const Row = Schema.Struct({
  run_id: Schema.String,
  session_id: Schema.String,
  project_id: Schema.String,
  goal_instance_id: Schema.String,
  workflow_revision_id: Schema.Finite,
  goal_version: Schema.Finite,
  plan_version: Schema.NullOr(Schema.Finite),
  current_goal: Schema.NullOr(Schema.String),
  current_revision: Schema.NullOr(Schema.Finite),
  status: Schema.String,
  error_code: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.Finite),
});
const Operation = Schema.Struct({
  operation_id: Schema.Finite,
  run_key: Schema.String,
  fingerprint: Schema.String,
  side_effect: Schema.Finite,
  status: Schema.String,
});
const Descriptor = Schema.Struct({ operation: Schema.String, input: Schema.Json });
const TaskId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
);
const Attempt = Schema.Struct({ taskId: TaskId, attemptId: TaskId });
// These background result/report retrievals have no durable write. Review/adoption middleware
// is deliberately outside this recovery policy, as are dispatch, resume, cancel and arbitrary tools.
const Call = Schema.Union([
  Schema.Struct({
    name: Schema.Literal("get_background_result"),
    toolCallId: Schema.NonEmptyString,
    args: Schema.Struct({
      taskId: TaskId,
      offset: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
    }),
  }),
  Schema.Struct({
    name: Schema.Literal("get_subagent_report"),
    toolCallId: Schema.NonEmptyString,
    args: Attempt,
  }),
  Schema.Struct({
    name: Schema.Literal("get_subagent_reports"),
    toolCallId: Schema.NonEmptyString,
    args: Schema.Struct({
      attempts: Schema.Array(Attempt).pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(32)),
      ),
    }),
  }),
]);
const readArgsKey = (call: typeof Call.Type) => {
  switch (call.name) {
    case "get_background_result":
      return JSON.stringify({ taskId: call.args.taskId, offset: call.args.offset ?? 0 });
    case "get_subagent_report":
      return JSON.stringify(call.args);
    case "get_subagent_reports":
      return JSON.stringify(call.args.attempts);
  }
};
const Key = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  workflowRevisionId: Schema.Finite,
  goalVersion: Schema.Finite,
  planVersion: Schema.NullOr(Schema.Finite),
});
const Execution = Schema.Struct({
  execution_id: Schema.String,
  payload_json: Schema.String,
  result_json: Schema.String,
});
const Failure = Schema.TaggedStruct("Complete", {
  exit: Schema.TaggedStruct("Failure", {
    cause: Schema.Array(
      Schema.TaggedStruct("Fail", {
        error: Schema.TaggedStruct("GoalExecutionError", {
          executionId: Schema.String,
          reason: Schema.TaggedStruct("SideEffectUncertain", {
            operationId: Schema.String,
            state: Schema.Literal("uncertain"),
          }),
        }),
      }),
    ),
  }),
});
const Receipt = Schema.Struct({
  receipt_id: Schema.String,
  assessment_id: Schema.String,
  backup_reference: Schema.String,
});
type BlockReason =
  | "run_not_found"
  | "run_not_failed"
  | "goal_changed"
  | "not_single_uncertain_read"
  | "invalid_record"
  | "authorization_missing"
  | "execution_failure_mismatch"
  | "work_outstanding"
  | "assessment_changed"
  | "confirmation_conflict";
const blocked = (reason: BlockReason) => ({ type: "blocked" as const, reason });
const digest = (value: string) => sha256(value);
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: string) =>
  Schema.decodeOption(Schema.fromJsonString(schema))(value);

export function makeOwnerReadRecovery({ sqlite, atomic }: Database["Service"]) {
  const read = (sessionId: string, runId: string) => {
    const existing = Schema.decodeUnknownOption(Schema.UndefinedOr(Receipt))(
      sqlite
        .prepare(
          "SELECT receipt_id, assessment_id, backup_reference FROM owner_read_recoveries WHERE run_id = ? AND session_id = ?",
        )
        .get(runId, sessionId),
    );
    const row = Schema.decodeUnknownOption(Schema.UndefinedOr(Row))(
      sqlite
        .prepare(`
      SELECT r.run_id, b.session_id, s.project_id, b.goal_instance_id, b.workflow_revision_id, b.goal_version,
        b.plan_version, g.goal_instance_id AS current_goal,
        (SELECT max(id) FROM workflow_state_revisions WHERE session_id = b.session_id) AS current_revision,
        r.status, r.error_code, r.finished_at
      FROM chat_runs r JOIN workflow_run_bindings b ON b.run_id = r.run_id
      JOIN sessions s ON s.id = b.session_id
      LEFT JOIN workflow_goal_identities g ON g.session_id = b.session_id
      WHERE r.run_id = ? AND r.thread_id = ? AND b.session_id = ?
    `)
        .get(runId, sessionId, sessionId),
    );
    const operations = Schema.decodeUnknownOption(Schema.Array(Operation))(
      sqlite
        .prepare(
          "SELECT operation_id,run_key,fingerprint,side_effect,status FROM owner_rpc_operations WHERE run_id = ? ORDER BY operation_id DESC LIMIT 2",
        )
        .all(runId),
    );
    const executions = Schema.decodeUnknownOption(Schema.Array(Execution))(
      sqlite
        .prepare(`
      SELECT execution_id,payload_json,result_json FROM owner_workflow_executions
      WHERE workflow_name='GoalExecution' AND status='completed' AND parent_execution_id IS NULL
        AND json_extract(payload_json, '$.identity.runId') = ?
    `)
        .all(runId),
    );
    const guards = sqlite
      .prepare(`SELECT
      (SELECT count(*) FROM owner_rpc_operations WHERE run_id = ? AND status <> 'succeeded') AS unresolved,
      (SELECT count(*) FROM chat_runs WHERE thread_id = ? AND status IN ('running','interrupted'))
      + (SELECT count(*) FROM work_tasks WHERE origin_session_id = ?
        AND (active_attempt_id IS NOT NULL OR status IN ('queued','running','waiting','resuming')))
      + (SELECT count(*) FROM chat_interrupts WHERE thread_id = ? AND status='pending')
      + (SELECT count(*) FROM queued_messages WHERE session_id = ? AND state IN ('waiting','editing','held'))
      + (SELECT count(*) FROM work_recovery_jobs j JOIN work_tasks t ON t.id=j.task_id
        WHERE t.origin_session_id = ? AND j.status IN ('queued','claimed'))
      + (SELECT count(*) FROM workflow_run_bindings b LEFT JOIN chat_runs r ON r.run_id=b.run_id
        WHERE b.session_id = ? AND b.run_id <> ? AND (r.status IS NULL OR r.status <> 'completed')
          AND NOT ${recoveredReadRunSql("r")})
      + (SELECT count(*) FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id=o.run_id
        LEFT JOIN chat_runs recovery_run ON recovery_run.run_id=b.run_id
        WHERE b.session_id=? AND o.run_id<>? AND (o.status='pending' OR (o.side_effect=1 AND o.status<>'succeeded'))
          AND NOT ${recoveredReadRunSql("recovery_run")}) AS outstanding
    `)
      .get(
        runId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        sessionId,
        runId,
        sessionId,
        runId,
      );
    return { existing, row, operations, executions, guards };
  };
  const assess = (data: ReturnType<typeof read>) => {
    if (
      Option.isNone(data.row) ||
      Option.isNone(data.operations) ||
      Option.isNone(data.executions) ||
      Option.isNone(data.existing)
    )
      return blocked("invalid_record");
    const row = data.row.value;
    if (data.existing.value !== undefined) return blocked("invalid_record");
    if (row === undefined) return blocked("run_not_found");
    if (
      row.status !== "failed" ||
      row.error_code !== "worker_execution_failed" ||
      row.finished_at === null
    )
      return blocked("run_not_failed");
    if (row.current_goal !== row.goal_instance_id || row.current_revision === null)
      return blocked("goal_changed");
    const [operation, authorization] = data.operations.value;
    if (
      operation?.status !== "uncertain" ||
      operation.side_effect !== 1 ||
      data.guards?.unresolved !== 1
    )
      return blocked("not_single_uncertain_read");
    const descriptor = parse(Descriptor, operation.fingerprint);
    if (Option.isNone(descriptor) || descriptor.value.operation !== "tool")
      return blocked("invalid_record");
    // The tagged SDK codec may throw on malformed frames; decoding never executes a tool.
    let call: Option.Option<typeof Call.Type>;
    let approved: Option.Option<typeof Call.Type>;
    try {
      call = Schema.decodeUnknownOption(Call)(decodeFullLoopValue(descriptor.value.input));
      const prior =
        authorization === undefined ? Option.none() : parse(Descriptor, authorization.fingerprint);
      approved =
        Option.isSome(prior) && prior.value.operation === "toolAuthorize"
          ? Schema.decodeUnknownOption(Call)(decodeFullLoopValue(prior.value.input))
          : Option.none();
    } catch {
      return blocked("invalid_record");
    }
    if (Option.isNone(call)) return blocked("not_single_uncertain_read");
    if (
      authorization?.status !== "succeeded" ||
      authorization.side_effect !== 1 ||
      authorization.run_key !== operation.run_key ||
      authorization.operation_id !== operation.operation_id - 1 ||
      Option.isNone(approved) ||
      approved.value.toolCallId !== call.value.toolCallId ||
      approved.value.name !== call.value.name ||
      readArgsKey(approved.value) !== readArgsKey(call.value)
    )
      return blocked("authorization_missing");
    const key = parse(Key, operation.run_key);
    if (
      Option.isNone(key) ||
      key.value.runId !== row.run_id ||
      key.value.sessionId !== row.session_id ||
      key.value.goalInstanceId !== row.goal_instance_id ||
      key.value.workflowRevisionId !== row.workflow_revision_id ||
      key.value.goalVersion !== row.goal_version ||
      key.value.planVersion !== row.plan_version
    )
      return blocked("invalid_record");
    const [execution] = data.executions.value;
    if (data.executions.value.length !== 1 || execution === undefined)
      return blocked("execution_failure_mismatch");
    const payload = parse(GoalExecutionPayload, execution.payload_json);
    const failure = parse(Failure, execution.result_json);
    if (
      Option.isNone(payload) ||
      payload.value.identity.runId !== row.run_id ||
      payload.value.identity.sessionId !== row.session_id ||
      payload.value.identity.owner.ownerId !== row.project_id ||
      payload.value.identity.goalInstanceId !== row.goal_instance_id ||
      payload.value.identity.workflowRevisionId !== row.workflow_revision_id ||
      Option.isNone(failure) ||
      failure.value.exit.cause.length !== 1 ||
      failure.value.exit.cause[0]?.error.executionId !== execution.execution_id ||
      failure.value.exit.cause[0]?.error.reason.operationId !== String(operation.operation_id)
    )
      return blocked("execution_failure_mismatch");
    if (data.guards?.outstanding !== 0) return blocked("work_outstanding");
    const assessmentId = digest(JSON.stringify([policy, row, operation, authorization, execution]));
    return {
      type: "eligible" as const,
      assessmentId,
      row,
      operation,
      authorization,
      execution,
      call: call.value,
    };
  };
  const publicAssessment = (result: ReturnType<typeof assess>) => {
    switch (result.type) {
      case "blocked":
        return result;
      case "eligible": {
        const base = {
          type: "eligible" as const,
          assessmentId: result.assessmentId,
          runId: result.row.run_id,
          operationId: result.operation.operation_id,
          disposition: "new_run_only_no_replay" as const,
          originalExceptionAvailable: false as const,
        };
        switch (result.call.name) {
          case "get_background_result":
            return { ...base, tool: result.call.name, taskId: result.call.args.taskId };
          case "get_subagent_report":
            return { ...base, tool: result.call.name, ...result.call.args };
          case "get_subagent_reports":
            return { ...base, tool: result.call.name, attempts: result.call.args.attempts };
        }
      }
    }
  };
  const persisted = (sessionId: string, runId: string) =>
    sqlite
      .prepare(
        `SELECT rr.receipt_id,rr.assessment_id,rr.backup_reference FROM owner_read_recoveries rr
     JOIN chat_runs r ON r.run_id=rr.run_id WHERE rr.session_id=? AND rr.run_id=? AND ${recoveredReadRunSql("r")}`,
      )
      .get(sessionId, runId);
  return {
    revoke: (sessionId: string, runId: string, input: ReadRecoveryRevocation) =>
      Effect.gen(function* () {
        const validated = yield* Schema.decodeEffect(ReadRecoveryRevocation)(input);
        return yield* Effect.try({
          try: () => {
            if (sqlite.isTransaction)
              throw new Error("Read recovery requires a standalone transaction");
            return atomic(() => {
              const data = read(sessionId, runId);
              if (
                Option.isNone(data.existing) ||
                data.existing.value?.receipt_id !== validated.receiptId
              )
                return blocked("confirmation_conflict");
              workflowRunEvents({ sqlite, atomic }).append(
                sessionId,
                runId,
                `operator:read-recovery:revoke:${validated.receiptId}`,
                "chunk",
                {
                  type: "CUSTOM",
                  name: "memory-agent.read-recovery-revoked",
                  value: { receiptId: validated.receiptId, confirmation: validated.confirmation },
                },
              );
              return { type: "revoked" as const, receiptId: validated.receiptId };
            });
          },
          catch: (cause) => ReadRecoveryStorageError.make({ phase: "write", cause }),
        });
      }),
    assess: (sessionId: string, runId: string) =>
      Effect.try({
        try: () => {
          const receipt = Schema.decodeUnknownOption(Schema.UndefinedOr(Receipt))(
            persisted(sessionId, runId),
          );
          if (Option.isSome(receipt) && receipt.value !== undefined)
            return {
              type: "recovered" as const,
              receiptId: receipt.value.receipt_id,
              assessmentId: receipt.value.assessment_id,
              disposition: "new_run_only_no_replay" as const,
            };
          return publicAssessment(assess(read(sessionId, runId)));
        },
        catch: (cause) => ReadRecoveryStorageError.make({ phase: "read", cause }),
      }),
    confirm: (sessionId: string, runId: string, input: ReadRecoveryConfirmation) =>
      Effect.gen(function* () {
        const validated = yield* Schema.decodeEffect(ReadRecoveryConfirmation)(input);
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => {
            if (sqlite.isTransaction)
              throw new Error("Read recovery requires a standalone transaction");
            return atomic(() => {
              const receipt = Schema.decodeUnknownOption(Schema.UndefinedOr(Receipt))(
                persisted(sessionId, runId),
              );
              if (Option.isSome(receipt) && receipt.value !== undefined)
                return receipt.value.assessment_id === validated.assessmentId &&
                  receipt.value.backup_reference === validated.backup.reference
                  ? {
                      type: "recovered" as const,
                      receiptId: receipt.value.receipt_id,
                      disposition: "new_run_only_no_replay" as const,
                    }
                  : blocked("confirmation_conflict");
              const result = assess(read(sessionId, runId));
              switch (result.type) {
                case "blocked":
                  return result;
                case "eligible": {
                  if (result.assessmentId !== validated.assessmentId)
                    return blocked("assessment_changed");
                  const receiptId = randomUUID();
                  sqlite
                    .prepare(`INSERT INTO owner_read_recoveries
                (receipt_id,run_id,session_id,goal_instance_id,workflow_revision_id,operation_id,operation_fingerprint,authorization_fingerprint,run_key,
                 finished_at,execution_id,execution_result_json,execution_payload_json,assessment_id,policy,confirmation,backup_reference,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                    .run(
                      receiptId,
                      runId,
                      sessionId,
                      result.row.goal_instance_id,
                      result.row.workflow_revision_id,
                      result.operation.operation_id,
                      result.operation.fingerprint,
                      result.authorization.fingerprint,
                      result.operation.run_key,
                      result.row.finished_at,
                      result.execution.execution_id,
                      result.execution.result_json,
                      result.execution.payload_json,
                      result.assessmentId,
                      policy,
                      validated.confirmation,
                      validated.backup.reference,
                      now,
                    );
                  return {
                    type: "recovered" as const,
                    receiptId,
                    disposition: "new_run_only_no_replay" as const,
                  };
                }
              }
            });
          },
          catch: (cause) => ReadRecoveryStorageError.make({ phase: "write", cause }),
        });
      }),
  };
}

export class OwnerReadRecovery extends Context.Service<
  OwnerReadRecovery,
  ReturnType<typeof makeOwnerReadRecovery>
>()("memory-agent/agent/owner-read-recovery/OwnerReadRecovery") {
  static readonly layer = Layer.effect(
    OwnerReadRecovery,
    Effect.gen(function* () {
      return makeOwnerReadRecovery(yield* Database);
    }),
  );
}
