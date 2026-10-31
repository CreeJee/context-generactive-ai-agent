import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

/** A session the report reads evidence from, after its project was checked. */
export interface ReportSession {
  readonly id: string;
  readonly projectId: string;
  readonly title: string | null;
}

const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.NullOr(Schema.String),
});
const SessionKey = Schema.Struct({ projectId: Schema.String, sessionId: Schema.String });

/** The project hint is not an authority. Enforce the pair before reading any report evidence. */
export const reportSession = Effect.fn("reportSession")(function* (
  projectId: string,
  sessionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: SessionKey,
    Result: SessionRow,
    execute: (key) =>
      sql`SELECT id, project_id, title FROM sessions WHERE id = ${key.sessionId} AND project_id = ${key.projectId}`,
  })({ projectId, sessionId });
  return Option.map(row, (found): ReportSession => ({
    id: found.id,
    projectId: found.project_id,
    title: found.title,
  }));
});
