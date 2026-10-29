import { Effect, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  DecisionKind,
  HumanDecisionPayload,
  humanDecisionWorkflow,
  LegacyHumanDecisionPayload,
} from "./human-decision-schema.ts";

const ExecutionRow = Schema.Struct({ execution_id: Schema.String, payload_json: Schema.String });
const decodeLegacy = Schema.decodeUnknownResult(Schema.fromJsonString(LegacyHumanDecisionPayload));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(HumanDecisionPayload));
const encodeKind = Schema.encodeEffect(Schema.fromJsonString(DecisionKind));

/**
 * Moves the human decision requests 0.0.17 stored to the split form, answered and closed ones too:
 * their history reads through the same decoder. The facts in the payload become the request's
 * first `human_decision_facts` row and the time it asked its `created_at`. The payload is encoded
 * again as the app encodes it, so asking the same occasion again matches it. A row it cannot decode
 * stays as it was; the app already skips those.
 */
export const migrateHumanDecisionRows = Effect.fn("HumanDecisions.migrateRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const executions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ExecutionRow,
    execute: () => sql`SELECT execution_id, payload_json FROM owner_workflow_executions
      WHERE workflow_name = ${humanDecisionWorkflow} ORDER BY execution_id`,
  });
  const moved = yield* Effect.forEach(yield* executions(), (row) =>
    Result.match(decodeLegacy(row.payload_json), {
      onFailure: () => Effect.succeed(false),
      onSuccess: ({ kind, createdAt, ...payload }) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO human_decision_facts (execution_id, seq, kind_json, observed_at)
            VALUES (${row.execution_id}, 1, ${yield* encodeKind(kind)}, ${createdAt})`;
          yield* sql`UPDATE owner_workflow_executions
            SET payload_json = ${yield* encodePayload(payload)}, created_at = coalesce(created_at, ${createdAt})
            WHERE execution_id = ${row.execution_id}`;
          return true;
        }),
    }),
  );
  const skipped = moved.filter((done) => !done).length;
  yield* Effect.when(
    Effect.logWarning("Human decision requests left in the 0.0.17 form", { skipped }),
    Effect.succeed(skipped > 0),
  );
});
