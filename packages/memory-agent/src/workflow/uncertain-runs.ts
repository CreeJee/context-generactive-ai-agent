import { Array as EffectArray, Data, DateTime, Effect, HashSet, Match, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { readOnlyToolNames } from "../tools/effects.ts";
import { invocationFieldSql, resolvedRunSql, toolOperationSql } from "./run-bindings.ts";

/**
 * How a tool of an ended run left its outcome unknown: its owner operation never settled
 * (`pending`, `uncertain`, `rejected`), or it succeeded but its result never reached the history a
 * later run reads (`unrecorded`).
 */
export type UncertainToolState = "pending" | "uncertain" | "rejected" | "unrecorded";

export interface UncertainTool {
  readonly toolCallId: string | null;
  readonly name: string | null;
  /** The recorded call with secrets hidden; null when the run stopped before recording it. */
  readonly call: string | null;
  readonly state: UncertainToolState;
}

/** A bound Goal run that keeps later runs from starting until the user decides about it. */
export interface UncertainRun {
  readonly runId: string;
  readonly tools: readonly UncertainTool[];
}

/** The runs the user saw listed, all of which the continue covers. */
export const UncertainContinueRequest = Schema.Struct({ runIds: Schema.Array(Schema.String) });
export type UncertainContinueRequest = typeof UncertainContinueRequest.Type;

export type UncertainContinue = Data.TaggedEnum<{
  acknowledged: {};
  refused: { readonly reason: "run_in_progress" | "uncertain_runs_changed" };
}>;
export const UncertainContinue = Data.taggedEnum<UncertainContinue>();

const Operation = Schema.Struct({
  status: Schema.Literals(["pending", "succeeded", "uncertain", "rejected"]),
  operation: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
  call: Schema.NullOr(Schema.String),
  recorded: Schema.Finite,
});
const Runs = Schema.Array(Schema.Struct({ runId: Schema.String }));
const Operations = Schema.Array(Operation);
const decodeOperations = Schema.decodeUnknownEffect(Operations);

const UncertainRunsFailedReason = Schema.TaggedUnion({
  Read: { cause: Schema.Defect() },
  Acknowledge: { cause: Schema.Defect() },
});

export class UncertainRunsFailed extends Schema.TaggedError<UncertainRunsFailed>()(
  "UncertainRunsFailed",
  { reason: UncertainRunsFailedReason },
) {}

const stateOf = (operation: typeof Operation.Type) =>
  Match.value(operation.status).pipe(
    Match.withReturnType<UncertainToolState | null>(),
    Match.whenOr("pending", "uncertain", "rejected", (status) => status),
    Match.when("succeeded", () =>
      operation.operation === "tool" &&
      !HashSet.has(readOnlyToolNames, operation.name ?? "") &&
      operation.recorded === 0
        ? "unrecorded"
        : null,
    ),
    Match.exhaustive,
  );

/**
 * Bound runs that admission refuses to start past, and the user's choice to continue anyway. Runs
 * still producing or waiting on an approval are not listed: those settle by themselves.
 */
export const uncertainRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const blocking = (sessionId: string) => sql`
    SELECT b.run_id AS runId FROM workflow_run_bindings b
    LEFT JOIN chat_runs r ON r.run_id = b.run_id
    WHERE b.session_id = ${sessionId} AND coalesce(r.status, '') <> 'running'
      AND NOT (r.status = 'interrupted' AND EXISTS (SELECT 1 FROM chat_interrupts i WHERE i.run_id = r.run_id))
      AND NOT ${sql.literal(resolvedRunSql("b", "r"))}
      AND (coalesce(r.status, '') <> 'completed' OR EXISTS (SELECT 1 FROM owner_rpc_operations o
        WHERE o.run_id = b.run_id AND (o.status = 'pending' OR (o.side_effect = 1 AND o.status <> 'succeeded'))))
    ORDER BY b.created_at, b.run_id`;
  // A fingerprint that is not JSON names no tool; it still counts, with no name to show.
  const field = (name: "name" | "toolCallId") =>
    `CASE WHEN json_valid(o.fingerprint) THEN ${invocationFieldSql("o", name)} END`;
  const operations = (runId: string) => sql`
    SELECT o.status,
      CASE WHEN json_valid(o.fingerprint) THEN json_extract(o.fingerprint, '$.operation') END AS operation,
      ${sql.literal(field("name"))} AS name, ${sql.literal(field("toolCallId"))} AS toolCallId,
      (SELECT n.text FROM nodes n WHERE n.session_id = b.session_id AND n.kind = 'tool_call'
        AND json_extract(n.detail, '$.toolCallId') = ${sql.literal(field("toolCallId"))} ORDER BY n.seq LIMIT 1) AS call,
      EXISTS (SELECT 1 FROM nodes n WHERE n.session_id = b.session_id AND n.kind = 'tool_result'
        AND json_extract(n.detail, '$.toolCallId') = ${sql.literal(field("toolCallId"))}) AS recorded
    FROM owner_rpc_operations o JOIN workflow_run_bindings b ON b.run_id = o.run_id
    WHERE o.run_id = ${runId} AND ${sql.literal(toolOperationSql("o"))}
    ORDER BY o.operation_id`;
  const producing = (sessionId: string) => sql`
    SELECT 1 FROM chat_runs WHERE thread_id = ${sessionId} AND status = 'running'
    UNION ALL SELECT 1 FROM owner_workflow_executions
    WHERE workflow_name = 'GoalExecution' AND status IN ('running', 'suspended')
      AND json_extract(payload_json, '$.identity.sessionId') = ${sessionId}
    LIMIT 1`;
  const read = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
    Effect.mapError(effect, (cause) =>
      UncertainRunsFailed.make({ reason: UncertainRunsFailedReason.cases.Read.make({ cause }) }),
    );

  const tools = Effect.fnUntraced(function* (runId: string) {
    const rows = yield* read(operations(runId));
    const decoded = yield* decodeOperations(rows);
    const listed = decoded.flatMap((operation): UncertainTool[] => {
      const state = stateOf(operation);
      return state === null
        ? []
        : [{ toolCallId: operation.toolCallId, name: operation.name, call: operation.call, state }];
    });
    // An authorization and the call it allowed share one tool call id; show the call once.
    return EffectArray.dedupeWith(
      listed,
      (left, right) => left.toolCallId !== null && left.toolCallId === right.toolCallId,
    );
  });

  const list = Effect.fnUntraced(function* (sessionId: string) {
    const rows = yield* read(blocking(sessionId));
    const runs = yield* Schema.decodeUnknownEffect(Runs)(rows);
    return yield* Effect.forEach(
      runs,
      Effect.fnUntraced(function* ({ runId }) {
        return { runId, tools: yield* tools(runId) } satisfies UncertainRun;
      }),
      { concurrency: 1 },
    );
  });

  return {
    list,
    /**
     * Records that the user saw exactly `runIds` and chose to continue. Refused while something
     * still runs, or when the runs left unknown changed since the user looked.
     */
    acknowledge: Effect.fnUntraced(function* (sessionId: string, runIds: readonly string[]) {
      const at = DateTime.formatIso(yield* DateTime.now);
      // Read, compare and write in one transaction, so the runs the user saw are the runs covered.
      return yield* sql
        .withTransaction(
          Effect.gen(function* (): Effect.fn.Return<
            UncertainContinue,
            SqlError.SqlError | Schema.SchemaError
          > {
            if ((yield* producing(sessionId)).length > 0)
              return UncertainContinue.refused({ reason: "run_in_progress" });
            const runs = yield* Schema.decodeUnknownEffect(Runs)(yield* blocking(sessionId));
            yield* Effect.forEach(
              runs,
              ({ runId }) => Effect.flatMap(operations(runId), decodeOperations),
              { discard: true },
            );
            const current = runs.map((run) => run.runId);
            const asked = new Set(runIds);
            if (
              current.length === 0 ||
              current.length !== asked.size ||
              !current.every((id) => asked.has(id))
            )
              return UncertainContinue.refused({ reason: "uncertain_runs_changed" });
            yield* Effect.forEach(
              current,
              (runId) => sql`
                INSERT INTO workflow_uncertain_acknowledgements (run_id, session_id, acknowledged_at)
                VALUES (${runId}, ${sessionId}, ${at}) ON CONFLICT DO NOTHING`,
              { discard: true },
            );
            return UncertainContinue.acknowledged();
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              UncertainRunsFailed.make({
                reason: UncertainRunsFailedReason.cases.Acknowledge.make({ cause }),
              }),
            ),
          ),
        );
    }),
  };
});
