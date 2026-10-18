import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ActivityFailed } from "./failure.ts";

export const Activity = Schema.Struct({ busy: Schema.Int, latest: Schema.NullOr(Schema.Finite) });
// Missing session ownership remains conservative; a known archived project is excluded.
// Archiving leaves conversations and memory intact and must not move the idle frontier.
export const activitySql = `SELECT
  (SELECT count(*) FROM chat_runs r
    LEFT JOIN sessions s ON s.id = r.thread_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE r.status IN ('running','interrupted') AND p.hidden_at IS NULL) +
  (SELECT count(*) FROM queued_messages q
    JOIN sessions s ON s.id = q.session_id
    JOIN projects p ON p.id = s.project_id
    WHERE q.state IN ('waiting','editing') AND p.hidden_at IS NULL) AS busy,
  (SELECT max(t.updated_at) FROM chat_threads t
    LEFT JOIN sessions s ON s.id = t.thread_id
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE p.hidden_at IS NULL) AS latest`;

/** Activity of the database behind the current SqlClient. */
export const readActivity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql.unsafe(activitySql).pipe(Effect.mapError(() => ActivityFailed.make()));
  return yield* Schema.decodeUnknownEffect(Activity)(row);
}).pipe(Effect.withSpan("Rrsi.readActivity"));
