import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import type { OwnerRpcLedger } from "./owner-rpc.ts";

const Binding = Schema.Struct({
  runId: Schema.String,
  sessionId: Schema.String,
  goalInstanceId: Schema.String,
  goalVersion: Schema.Finite,
  planVersion: Schema.NullOr(Schema.Finite),
  workflowRevisionId: Schema.Finite,
});
const Reply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("succeeded"),
    operationId: Schema.Finite,
    output: Schema.Json,
  }),
  Schema.Struct({ type: Schema.Literals(["pending", "uncertain"]), operationId: Schema.Finite }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    operationId: Schema.Finite,
    reason: Schema.Literals([
      "unauthorized",
      "invalid_operation",
      "operation_conflict",
      "non_monotonic",
      "uncertain_run",
    ]),
  }),
]);
const Row = Schema.UndefinedOr(
  Schema.Struct({ fingerprint: Schema.String, reply_json: Schema.String }),
);

/** Central owner only. Pass the shared Database service; never construct this in a worker.
 * Authority/generation checks remain in makeOwnerRpc.permits on admission AND late replies.
 * Keys deliberately exclude ephemeral generations, so rotating one cannot reset a reservation.
 */
export function makeSqliteOwnerRpcLedger({
  sqlite,
  atomic,
}: {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
}): OwnerRpcLedger {
  const bound = sqlite.prepare(`SELECT run_id FROM workflow_run_bindings
    WHERE run_id = ? AND session_id = ? AND goal_instance_id = ? AND goal_version = ?
    AND plan_version IS ? AND workflow_revision_id = ?`);
  const existing = sqlite.prepare(
    "SELECT fingerprint, reply_json FROM owner_rpc_operations WHERE run_id = ? AND operation_id = ? AND run_key = ?",
  );
  const highWater = sqlite.prepare(
    "SELECT max(operation_id) AS high_water FROM owner_rpc_operations WHERE run_id = ?",
  );
  const effects = sqlite.prepare(
    `SELECT operations.operation_id FROM owner_rpc_operations AS operations
      JOIN workflow_run_bindings AS binding ON binding.run_id = operations.run_id
      WHERE binding.session_id = ? AND binding.goal_instance_id = ?
      AND operations.side_effect = 1 AND operations.status <> 'succeeded' LIMIT 1`,
  );
  const insert = sqlite.prepare(`INSERT INTO owner_rpc_operations
    (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`);
  const update = sqlite.prepare(`UPDATE owner_rpc_operations SET reply_json = ?, status = ?
    WHERE run_id = ? AND operation_id = ? AND run_key = ? AND status = 'pending'`);
  const identify = (runKey: string) => {
    const b = Schema.decodeSync(Schema.fromJsonString(Binding))(runKey);
    if (
      !bound.get(
        b.runId,
        b.sessionId,
        b.goalInstanceId,
        b.goalVersion,
        b.planVersion,
        b.workflowRevisionId,
      )
    )
      throw new Error("Owner RPC has no verified run binding");
    return b;
  };
  // A savepoint is not a durable reservation: an outer rollback could erase it
  // after dispatch. Both admission and settlement must own their commit boundary.
  const requireStandalone = () => {
    if (sqlite.isTransaction) throw new Error("Owner RPC ledger requires a standalone transaction");
  };
  return {
    reserve(runKey, operationId, fingerprint, sideEffect) {
      requireStandalone();
      if (!Number.isSafeInteger(operationId) || operationId < 1)
        throw new Error("Invalid operation ID");
      return atomic(() => {
        const { runId, sessionId, goalInstanceId } = identify(runKey);
        const row = Schema.decodeUnknownSync(Row)(existing.get(runId, operationId, runKey));
        if (row)
          return {
            type: "existing",
            record: {
              fingerprint: row.fingerprint,
              reply: Schema.decodeSync(Schema.fromJsonString(Reply))(row.reply_json),
            },
          };
        const water = Schema.decodeUnknownSync(
          Schema.Struct({ high_water: Schema.NullOr(Schema.Finite) }),
        )(highWater.get(runId));
        if (operationId <= (water.high_water ?? 0))
          return { type: "rejected", reason: "non_monotonic" };
        if (sideEffect && effects.get(sessionId, goalInstanceId))
          return { type: "rejected", reason: "uncertain_run" };
        insert.run(
          runId,
          runKey,
          operationId,
          fingerprint,
          sideEffect ? 1 : 0,
          JSON.stringify({ type: "pending", operationId }),
        );
        return { type: "reserved" };
      });
    },
    settle(runKey, operationId, reply) {
      requireStandalone();
      const validated = Schema.decodeSync(Reply)(reply);
      if (validated.operationId !== operationId) throw new Error("Owner RPC reply ID mismatch");
      atomic(() => {
        const { runId } = identify(runKey);
        if (
          update.run(JSON.stringify(validated), validated.type, runId, operationId, runKey)
            .changes !== 1
        )
          throw new Error("Unreserved or already settled owner RPC operation");
      });
    },
  };
}
