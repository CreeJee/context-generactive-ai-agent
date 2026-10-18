import { type Cause, Effect, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
import { type OwnerRpcLedger, OwnerRpcLedgerError } from "./owner-rpc.ts";
import { recoveredReadRunSql } from "./owner-read-recovery.ts";
import { endedWithKnownEffectsSql } from "../workflow/run-bindings.ts";

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
const Row = Schema.Struct({ fingerprint: Schema.String, reply_json: Schema.String });
const BindingJson = Schema.fromJsonString(Binding);
const ReplyJson = Schema.fromJsonString(Reply);

/** Central owner only, on the app's SqlClient; never construct this in a worker.
 * Authority/generation checks remain in makeOwnerRpc.permits on admission AND late replies.
 * Keys deliberately exclude ephemeral generations, so rotating one cannot reset a reservation.
 */
export const makeSqliteOwnerRpcLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = SqlSchema.findOneOption({
    Request: Schema.Struct({
      runId: Schema.String,
      operationId: Schema.Finite,
      runKey: Schema.String,
    }),
    Result: Row,
    execute: ({ runId, operationId, runKey }) => sql`
      SELECT fingerprint, reply_json FROM owner_rpc_operations
      WHERE run_id = ${runId} AND operation_id = ${operationId} AND run_key = ${runKey}`,
  });
  const highWater = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ high_water: Schema.NullOr(Schema.Finite) }),
    execute: (runId) =>
      sql`SELECT max(operation_id) AS high_water FROM owner_rpc_operations WHERE run_id = ${runId}`,
  });
  const identify = Effect.fnUntraced(function* (runKey: string) {
    const b = yield* Schema.decodeEffect(BindingJson)(runKey);
    const bound = yield* sql`
      SELECT run_id FROM workflow_run_bindings
      WHERE run_id = ${b.runId} AND session_id = ${b.sessionId}
        AND goal_instance_id = ${b.goalInstanceId} AND goal_version = ${b.goalVersion}
        AND plan_version IS ${b.planVersion} AND workflow_revision_id = ${b.workflowRevisionId}`;
    if (bound.length === 0) return yield* OwnerRpcLedgerError.make({ reason: "unbound_run" });
    return b;
  });
  // A savepoint is not a durable reservation: an outer rollback could erase it
  // after dispatch. Both admission and settlement must own their commit boundary.
  const standalone = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.flatMap(
      Effect.serviceOption(sql.transactionService),
      (outer): Effect.Effect<A, E | SqlError.SqlError | OwnerRpcLedgerError> =>
        Option.isNone(outer)
          ? sql.withTransaction(effect)
          : Effect.fail(OwnerRpcLedgerError.make({ reason: "outer_transaction" })),
    );
  /** Storage and codec failures keep their cause under the ledger's own error. */
  const stored = <A>(
    effect: Effect.Effect<
      A,
      OwnerRpcLedgerError | SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError
    >,
  ): Effect.Effect<A, OwnerRpcLedgerError> =>
    Effect.mapError(effect, (cause) => {
      switch (cause._tag) {
        case "OwnerRpcLedgerError":
          return cause;
        case "SqlError":
        case "SchemaError":
        case "NoSuchElementError":
          return OwnerRpcLedgerError.make({ reason: "storage", cause });
      }
    });

  const ledger: OwnerRpcLedger = {
    reserve: (runKey, operationId, fingerprint, sideEffect) =>
      stored(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(operationId) || operationId < 1)
            return yield* OwnerRpcLedgerError.make({ reason: "invalid_operation_id" });
          const pending = yield* Schema.encodeEffect(ReplyJson)({ type: "pending", operationId });
          return yield* standalone(
            Effect.gen(function* () {
              const { runId, sessionId, goalInstanceId } = yield* identify(runKey);
              const row = yield* existing({ runId, operationId, runKey });
              if (Option.isSome(row))
                return {
                  type: "existing" as const,
                  record: {
                    fingerprint: row.value.fingerprint,
                    reply: yield* Schema.decodeEffect(ReplyJson)(row.value.reply_json),
                  },
                };
              // Recovery permits a different run only, including for read-only new RPCs.
              if (
                (yield* sql`SELECT 1 FROM owner_read_recoveries WHERE run_id = ${runId}`).length > 0
              )
                return { type: "rejected" as const, reason: "uncertain_run" as const };
              const water = yield* highWater(runId);
              if (operationId <= (water.high_water ?? 0))
                return { type: "rejected" as const, reason: "non_monotonic" as const };
              if (
                sideEffect &&
                (yield* sql`
                  SELECT operations.operation_id FROM owner_rpc_operations AS operations
                  JOIN workflow_run_bindings AS binding ON binding.run_id = operations.run_id
                  LEFT JOIN chat_runs recovery_run ON recovery_run.run_id = operations.run_id
                  WHERE binding.session_id = ${sessionId} AND binding.goal_instance_id = ${goalInstanceId}
                    AND operations.side_effect = 1 AND operations.status <> 'succeeded'
                    AND NOT ${sql.literal(recoveredReadRunSql("recovery_run"))}
                    AND NOT ${sql.literal(endedWithKnownEffectsSql("recovery_run"))} LIMIT 1`)
                  .length > 0
              )
                return { type: "rejected" as const, reason: "uncertain_run" as const };
              yield* sql`
                INSERT INTO owner_rpc_operations
                  (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
                VALUES (${runId}, ${runKey}, ${operationId}, ${fingerprint}, ${sideEffect ? 1 : 0},
                  ${pending}, 'pending')`;
              return { type: "reserved" as const };
            }),
          );
        }),
      ),
    settle: (runKey, operationId, reply) =>
      stored(
        Effect.gen(function* () {
          const validated = yield* Schema.decodeEffect(Reply)(reply);
          if (validated.operationId !== operationId)
            return yield* OwnerRpcLedgerError.make({ reason: "reply_mismatch" });
          const json = yield* Schema.encodeEffect(ReplyJson)(validated);
          yield* standalone(
            Effect.gen(function* () {
              const { runId } = yield* identify(runKey);
              const settled = yield* sql`
                UPDATE owner_rpc_operations SET reply_json = ${json}, status = ${validated.type}
                WHERE run_id = ${runId} AND operation_id = ${operationId} AND run_key = ${runKey}
                  AND status = 'pending' RETURNING operation_id`;
              if (settled.length !== 1)
                return yield* OwnerRpcLedgerError.make({ reason: "unreserved" });
            }),
          );
        }),
      ),
  };
  return ledger;
});
