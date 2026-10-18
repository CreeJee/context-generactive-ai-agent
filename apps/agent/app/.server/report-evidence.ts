import { isTruthy } from "../truthy.ts";
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

const MAX_NODES = 16;
const MAX_TEXT = 1200;
const MAX_DETAIL_TEXT = 8000;
const MAX_TRANSCRIPT = 8;
const MAX_RUNS = 3;

import type { EvidenceSection, ReportEvidence } from "../entry/report/report-contracts";
export type {
  EvidenceStatus,
  EvidenceSection,
  ReportEvidence,
} from "../entry/report/report-contracts";

const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.NullOr(Schema.String),
});
const SessionKey = Schema.Struct({ projectId: Schema.String, sessionId: Schema.String });
const RunRow = Schema.Struct({
  run_id: Schema.String,
  status: Schema.String,
  started_at: Schema.Finite,
  finished_at: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  error_cut: Schema.NullOr(Schema.Finite),
});
const ApprovalRow = Schema.Struct({
  run_id: Schema.String,
  status: Schema.String,
  requested_at: Schema.Finite,
  resolved_at: Schema.NullOr(Schema.Finite),
});
const ExcerptRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  run_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  excerpt: Schema.String,
  cut: Schema.Finite,
  tool_call_id: Schema.NullOr(Schema.String),
  tool_name: Schema.NullOr(Schema.String),
});
const CallRow = Schema.Struct({ ...ExcerptRow.fields, ok: Schema.NullOr(Schema.Finite) });

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
  return Option.map(row, (found): ReportEvidence["session"] => ({
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
    ? Option.some({ projectId, sessionId, itemId: url.searchParams.get("item") })
    : Option.none();
};

export const reportEvidenceResponse = Effect.fn("reportEvidenceResponse")(function* <E>(
  request: Request,
  traceTasks: (sessionId: string) => Effect.Effect<ReportEvidence["trace"]["items"], E>,
) {
  const query = queryIdentifiers(request);
  if (Option.isNone(query)) return json({ error: "project_and_session_required" }, 400);
  const { projectId, sessionId } = query.value;
  const session = yield* reportSession(projectId, sessionId);
  if (Option.isNone(session)) return json({ error: "session_not_found" }, 404);
  return json(yield* collectReportEvidence(session.value, traceTasks(sessionId)));
});

export const reportEvidenceItemResponse = Effect.fn("reportEvidenceItemResponse")(function* (
  request: Request,
) {
  const query = queryIdentifiers(request);
  if (Option.isNone(query) || !isTruthy(query.value.itemId) || query.value.itemId.length > 256)
    return json({ error: "project_session_item_required" }, 400);
  const { projectId, sessionId, itemId } = query.value;
  const session = yield* reportSession(projectId, sessionId);
  if (Option.isNone(session)) return json({ error: "session_not_found" }, 404);
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExcerptRow,
    execute: (id) => sql`
      SELECT id, kind, run_id, created_at, substr(text, 1, ${MAX_DETAIL_TEXT}) AS excerpt,
      length(text) > ${MAX_DETAIL_TEXT} AS cut,
      substr(json_extract(detail, '$.toolCallId'), 1, 128) AS tool_call_id,
      substr(json_extract(detail, '$.toolName'), 1, 128) AS tool_name
      FROM nodes WHERE id = ${id} AND session_id = ${session.value.id}
      AND project_id = ${session.value.projectId}
      AND kind IN ('tool_call', 'tool_result')`,
  })(itemId);
  if (Option.isNone(row)) return json({ error: "item_not_found" }, 404);
  const found = row.value;
  return json({
    id: found.id,
    kind: found.kind,
    runId: found.run_id,
    createdAt: found.created_at,
    toolCallId: found.tool_call_id,
    toolName: found.tool_name,
    text: found.excerpt,
    truncated: Boolean(found.cut),
  });
});

const section = <T>(items: readonly T[], limit: number): EvidenceSection<T> => ({
  status: isTruthy(items.length) ? "available" : "empty",
  truncated: items.length > limit,
  items: items.slice(0, limit),
});

/** A broken evidence source marks only its own section failed; the report still opens. */
const guarded = <T, E, R>(
  load: Effect.Effect<readonly T[], E, R>,
  limit: number,
): Effect.Effect<EvidenceSection<T>, never, R> =>
  load.pipe(
    Effect.map((items) => section(items, limit)),
    Effect.orElseSucceed((): EvidenceSection<T> => ({
      status: "failed",
      items: [],
      truncated: false,
    })),
  );

/** Read only bounded excerpts, not entire transcript blobs or unredacted provider wire output. */
export const collectReportEvidence = Effect.fn("collectReportEvidence")(function* <E>(
  session: ReportEvidence["session"],
  traceTasks: Effect.Effect<ReportEvidence["trace"]["items"], E>,
) {
  const sql = yield* SqlClient.SqlClient;
  const runs = SqlSchema.findAll({
    Request: Schema.String,
    Result: RunRow,
    execute: (threadId) => sql`
      SELECT run_id, status, started_at, finished_at, substr(error, 1, ${MAX_TEXT}) AS error,
        length(error) > ${MAX_TEXT} AS error_cut FROM chat_runs
      WHERE thread_id = ${threadId} ORDER BY started_at DESC LIMIT ${MAX_RUNS + 1}`,
  })(session.id).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        runId: row.run_id,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        error: row.error,
        truncated: Boolean(row.error_cut),
      })),
    ),
  );
  const approvals = SqlSchema.findAll({
    Request: Schema.String,
    Result: ApprovalRow,
    execute: (threadId) => sql`
      SELECT run_id, status, requested_at, resolved_at FROM chat_interrupts
      WHERE thread_id = ${threadId} ORDER BY requested_at DESC LIMIT 4`,
  })(session.id).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        runId: row.run_id,
        status: row.status,
        requestedAt: row.requested_at,
        resolvedAt: row.resolved_at,
      })),
    ),
  );
  const excerpts = (kinds: readonly string[], limit: number) =>
    SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: CallRow,
      execute: (wanted) => sql`
        SELECT id, kind, run_id, created_at, substr(text, 1, ${MAX_TEXT}) AS excerpt,
          length(text) > ${MAX_TEXT} AS cut,
          substr(json_extract(detail, '$.toolCallId'), 1, 128) AS tool_call_id,
          substr(json_extract(detail, '$.toolName'), 1, 128) AS tool_name,
          json_extract(detail, '$.ok') AS ok FROM nodes
        WHERE session_id = ${session.id} AND project_id = ${session.projectId}
          AND kind IN ${sql.in(wanted)}
        ORDER BY seq DESC LIMIT ${limit + 1}`,
    })(kinds);
  const transcript = excerpts(["user", "assistant"], MAX_TRANSCRIPT).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        runId: row.run_id,
        createdAt: row.created_at,
        text: row.excerpt,
        truncated: Boolean(row.cut),
      })),
    ),
  );
  const calls = excerpts(["tool_call", "tool_result"], MAX_NODES).pipe(
    Effect.map((rows) =>
      rows.map((node) => ({
        id: node.id,
        kind: node.kind,
        runId: node.run_id,
        toolCallId: node.tool_call_id,
        toolName: node.tool_name,
        ok: node.ok === null ? null : Boolean(node.ok),
        createdAt: node.created_at,
        text: node.excerpt,
        truncated: Boolean(node.cut),
      })),
    ),
  );
  return yield* Effect.all(
    {
      session: Effect.succeed(session),
      runs: guarded(runs, MAX_RUNS),
      approvals: guarded(approvals, 3),
      transcript: guarded(transcript, MAX_TRANSCRIPT),
      calls: guarded(calls, MAX_NODES),
      trace: guarded(traceTasks, 5),
    },
    { concurrency: 1 },
  );
});
