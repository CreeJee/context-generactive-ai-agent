import { isTruthy } from "../truthy.ts";
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import type { ReportBundle } from "memory-agent";

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

const json = <Body>(body: Body, status = 200) =>
  Response.json(body, {
    status,
    headers: status === 200 ? { "Cache-Control": "no-store" } : undefined,
  });

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

const queryIdentifiers = (request: Request) => {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project");
  const sessionId = url.searchParams.get("session");
  return isTruthy(projectId) &&
    isTruthy(sessionId) &&
    projectId.length <= 256 &&
    sessionId.length <= 256
    ? Option.some({ projectId, sessionId })
    : Option.none();
};

/** The session's evidence bundle, once the project and session are known to belong together. */
export const reportBundleResponse = Effect.fn("reportBundleResponse")(function* <E, R>(
  request: Request,
  collect: (session: ReportSession) => Effect.Effect<ReportBundle, E, R>,
) {
  const query = queryIdentifiers(request);
  if (Option.isNone(query)) return json({ error: "project_and_session_required" }, 400);
  const { projectId, sessionId } = query.value;
  const session = yield* reportSession(projectId, sessionId);
  if (Option.isNone(session)) return json({ error: "session_not_found" }, 404);
  return json(yield* collect(session.value));
});
