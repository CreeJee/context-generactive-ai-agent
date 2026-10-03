import type { StreamChunk } from "@tanstack/ai";
import { Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";

type OwnerDatabase = {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
};

export type RunEventKind = "chunk" | "run_error" | "run_completed";
export type RunEvent = {
  readonly cursor: number;
  readonly runId: string;
  readonly eventKey: string;
  readonly kind: RunEventKind;
  readonly payload: Schema.Json;
};

/** Central-owner receipts for bound runs; not an authorization or an SSE adapter. */
export function workflowRunEvents({ sqlite, atomic }: OwnerDatabase) {
  const owner = sqlite.prepare("SELECT session_id FROM workflow_run_bindings WHERE run_id = ?");
  const insert = sqlite.prepare(`
    INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, event_key) DO NOTHING
  `);
  const byKey = sqlite.prepare(`
    SELECT cursor, run_id, event_key, kind, payload_json
    FROM workflow_run_events WHERE run_id = ? AND event_key = ?
  `);
  const byCursor = sqlite.prepare(`
    SELECT cursor, run_id, event_key, kind, payload_json
    FROM workflow_run_events WHERE run_id = ? AND cursor > ? ORDER BY cursor LIMIT ?
  `);
  const Row = Schema.Struct({
    cursor: Schema.Finite,
    run_id: Schema.String,
    event_key: Schema.String,
    kind: Schema.Literals(["chunk", "run_error", "run_completed"]),
    payload_json: Schema.String,
  });
  type Row = typeof Row.Type;
  const decode = (row: Row): RunEvent => ({
    cursor: row.cursor,
    runId: row.run_id,
    eventKey: row.event_key,
    kind: row.kind,
    payload: Schema.decodeSync(Schema.fromJsonString(Schema.Json))(row.payload_json),
  });
  const permitted = (sessionId: string, runId: string) =>
    Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Struct({ session_id: Schema.String })))(
      owner.get(runId),
    )?.session_id === sessionId;

  return {
    append: (
      sessionId: string,
      runId: string,
      eventKey: string,
      kind: RunEventKind,
      payload: StreamChunk | Schema.Json,
    ) => {
      const json = JSON.stringify(payload);
      if (json === undefined) throw new Error("Run event payload is not JSON serializable");
      return atomic(() => {
        if (!permitted(sessionId, runId)) throw new Error("Run event has no owner binding");
        insert.run(runId, eventKey, kind, json, new Date().toISOString());
        const row = Schema.decodeUnknownSync(Schema.UndefinedOr(Row))(byKey.get(runId, eventKey));
        if (!row || row.kind !== kind || row.payload_json !== json)
          throw new Error("Run event key was reused for different content");
        return decode(row);
      });
    },
    replay: (
      sessionId: string,
      runId: string,
      afterCursor = 0,
      limit = 256,
    ): readonly RunEvent[] => {
      if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
        throw new Error("Invalid run cursor");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
        throw new Error("Invalid run limit");
      if (!permitted(sessionId, runId)) return [];
      return Schema.decodeUnknownSync(Schema.Array(Row))(
        byCursor.all(runId, afterCursor, limit),
      ).map(decode);
    },
  };
}
