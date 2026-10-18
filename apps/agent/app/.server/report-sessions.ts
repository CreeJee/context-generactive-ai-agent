import { Crypto, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

export interface ReportSessionBinding {
  reportSessionId: string;
  sourceSessionId: string;
  projectId: string;
}

const Source = Schema.Struct({ projectId: Schema.String, sourceSessionId: Schema.String });

/** Single SQLite transaction: repeat clicks/tabs cannot create competing report sessions. */
export const openReportSession = Effect.fn("openReportSession")(function* (
  projectId: string,
  sourceSessionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = yield* (yield* Crypto.Crypto).randomUUIDv4();
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const source = SqlSchema.findOneOption({
    Request: Source,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (key) => sql`
      SELECT s.id FROM sessions s WHERE s.id = ${key.sourceSessionId} AND s.project_id = ${key.projectId}
      AND NOT EXISTS (SELECT 1 FROM report_sessions r WHERE r.report_session_id = s.id)`,
  });
  const existing = SqlSchema.findOneOption({
    Request: Source,
    Result: Schema.Struct({ report_session_id: Schema.String }),
    execute: (key) => sql`
      SELECT report_session_id FROM report_sessions
      WHERE source_session_id = ${key.sourceSessionId} AND project_id = ${key.projectId}`,
  });
  const create = Effect.gen(function* () {
    yield* sql`INSERT INTO sessions (id, project_id, title, created_at)
      VALUES (${id}, ${projectId}, ${"문제 제보 분석"}, ${createdAt})`;
    yield* sql`INSERT INTO report_sessions (report_session_id, source_session_id, project_id, created_at)
      VALUES (${id}, ${sourceSessionId}, ${projectId}, ${createdAt})`;
    return id;
  });
  return yield* Effect.gen(function* () {
    if (Option.isNone(yield* source({ projectId, sourceSessionId }))) return null;
    const reportSessionId = yield* Option.match(yield* existing({ projectId, sourceSessionId }), {
      onNone: () => create,
      onSome: (row) => Effect.succeed(row.report_session_id),
    });
    return { reportSessionId, sourceSessionId, projectId } satisfies ReportSessionBinding;
  }).pipe(sql.withTransaction);
});
