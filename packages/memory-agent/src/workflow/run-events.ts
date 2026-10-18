import type { StreamChunk } from "@tanstack/ai";
import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

export type RunEventKind = "chunk" | "run_error" | "run_completed";
export type RunEvent = {
  readonly cursor: number;
  readonly runId: string;
  readonly eventKey: string;
  readonly kind: RunEventKind;
  readonly payload: Schema.Json;
};

/** A run event the owner refuses to append or replay. */
export class RunEventRejected extends Schema.TaggedError<RunEventRejected>()("RunEventRejected", {
  reason: Schema.Literals(["unbound", "key-reused", "invalid-cursor", "invalid-limit"]),
}) {}

const Row = Schema.Struct({
  cursor: Schema.Finite,
  run_id: Schema.String,
  event_key: Schema.String,
  kind: Schema.Literals(["chunk", "run_error", "run_completed"]),
  payload_json: Schema.String,
});
type Row = typeof Row.Type;
const JsonText = Schema.fromJsonString(Schema.Json);
// Chunks carry optional fields as `undefined`; they are dropped, not refused, as JSON.
const PayloadText = Schema.fromJsonString(Schema.Unknown);

/** Central-owner receipts for bound runs; not an authorization or an SSE adapter. */
export const workflowRunEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owner = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ session_id: Schema.String }),
    execute: (runId) => sql`SELECT session_id FROM workflow_run_bindings WHERE run_id = ${runId}`,
  });
  const byKey = SqlSchema.findOneOption({
    Request: Schema.Struct({ runId: Schema.String, eventKey: Schema.String }),
    Result: Row,
    execute: ({ runId, eventKey }) => sql`
      SELECT cursor, run_id, event_key, kind, payload_json
      FROM workflow_run_events WHERE run_id = ${runId} AND event_key = ${eventKey}`,
  });
  const byCursor = SqlSchema.findAll({
    Request: Schema.Struct({ runId: Schema.String, after: Schema.Finite, limit: Schema.Finite }),
    Result: Row,
    execute: ({ runId, after, limit }) => sql`
      SELECT cursor, run_id, event_key, kind, payload_json
      FROM workflow_run_events WHERE run_id = ${runId} AND cursor > ${after}
      ORDER BY cursor LIMIT ${limit}`,
  });
  const decode = Effect.fnUntraced(function* (row: Row) {
    return {
      cursor: row.cursor,
      runId: row.run_id,
      eventKey: row.event_key,
      kind: row.kind,
      payload: yield* Schema.decodeEffect(JsonText)(row.payload_json),
    } satisfies RunEvent;
  });
  const permitted = (sessionId: string, runId: string) =>
    Effect.map(owner(runId), (row) => Option.getOrUndefined(row)?.session_id === sessionId);

  return {
    append: (
      sessionId: string,
      runId: string,
      eventKey: string,
      kind: RunEventKind,
      payload: StreamChunk | Schema.Json,
    ) =>
      Effect.gen(function* () {
        const json = yield* Schema.encodeUnknownEffect(PayloadText)(payload);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* permitted(sessionId, runId)))
              return yield* RunEventRejected.make({ reason: "unbound" });
            yield* sql`
              INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at)
              VALUES (${runId}, ${eventKey}, ${kind}, ${json}, ${DateTime.formatIso(yield* DateTime.now)})
              ON CONFLICT(run_id, event_key) DO NOTHING`;
            const row = Option.getOrUndefined(yield* byKey({ runId, eventKey }));
            if (row === undefined || row.kind !== kind || row.payload_json !== json)
              return yield* RunEventRejected.make({ reason: "key-reused" });
            return yield* decode(row);
          }),
        );
      }),
    replay: Effect.fnUntraced(function* (
      sessionId: string,
      runId: string,
      afterCursor = 0,
      limit = 256,
    ) {
      if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
        return yield* RunEventRejected.make({ reason: "invalid-cursor" });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
        return yield* RunEventRejected.make({ reason: "invalid-limit" });
      if (!(yield* permitted(sessionId, runId))) return [];
      return yield* Effect.forEach(yield* byCursor({ runId, after: afterCursor, limit }), decode);
    }),
  };
});
