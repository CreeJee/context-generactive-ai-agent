import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const MAX_NODES = 16;
const MAX_TEXT = 1200;
const MAX_DETAIL_TEXT = 8000;
const MAX_TRANSCRIPT = 8;
const MAX_RUNS = 3;
const optionalText = Schema.decodeUnknownSync(Schema.NullOr(Schema.String));

export type EvidenceStatus = "available" | "empty" | "failed";
export interface EvidenceSection<T> {
  status: EvidenceStatus;
  items: T[];
  truncated: boolean;
}
export interface ReportEvidence {
  session: { id: string; projectId: string; title: string | null };
  runs: EvidenceSection<{
    runId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    truncated: boolean;
  }>;
  approvals: EvidenceSection<{
    runId: string;
    status: string;
    requestedAt: number;
    resolvedAt: number | null;
  }>;
  transcript: EvidenceSection<{
    id: string;
    kind: string;
    runId: string | null;
    createdAt: string;
    text: string;
    truncated: boolean;
  }>;
  calls: EvidenceSection<{
    id: string;
    kind: string;
    runId: string | null;
    toolCallId: string | null;
    toolName: string | null;
    ok: boolean | null;
    createdAt: string;
    text: string;
    truncated: boolean;
  }>;
  trace: EvidenceSection<{
    id: string;
    status: string;
    parentRunId: string;
    parentToolCallId: string;
    updatedAt: number;
  }>;
}

export function reportEvidenceResponse(
  sqlite: DatabaseSync,
  request: Request,
  traceTasks: (sessionId: string) => ReportEvidence["trace"]["items"],
): Response {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project");
  const sessionId = url.searchParams.get("session");
  if (!projectId || !sessionId || projectId.length > 256 || sessionId.length > 256)
    return Response.json({ error: "project_and_session_required" }, { status: 400 });
  const session = reportSession(sqlite, projectId, sessionId);
  if (!session) return Response.json({ error: "session_not_found" }, { status: 404 });
  return Response.json(
    collectReportEvidence(sqlite, session, () => traceTasks(sessionId)),
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function reportEvidenceItemResponse(sqlite: DatabaseSync, request: Request): Response {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project");
  const sessionId = url.searchParams.get("session");
  const itemId = url.searchParams.get("item");
  if (
    !projectId ||
    !sessionId ||
    !itemId ||
    projectId.length > 256 ||
    sessionId.length > 256 ||
    itemId.length > 256
  )
    return Response.json({ error: "project_session_item_required" }, { status: 400 });
  const session = reportSession(sqlite, projectId, sessionId);
  if (!session) return Response.json({ error: "session_not_found" }, { status: 404 });
  const row = sqlite
    .prepare(
      `SELECT id, kind, run_id, created_at, substr(text, 1, ?) AS excerpt,
      length(text) > ? AS cut,
      substr(json_extract(detail, '$.toolCallId'), 1, 128) AS tool_call_id,
      substr(json_extract(detail, '$.toolName'), 1, 128) AS tool_name
      FROM nodes WHERE id = ? AND session_id = ? AND project_id = ?
      AND kind IN ('tool_call', 'tool_result')`,
    )
    .get(MAX_DETAIL_TEXT, MAX_DETAIL_TEXT, itemId, session.id, session.projectId);
  if (!row) return Response.json({ error: "item_not_found" }, { status: 404 });
  return Response.json(
    {
      id: String(row.id),
      kind: String(row.kind),
      runId: optionalText(row.run_id),
      createdAt: String(row.created_at),
      toolCallId: optionalText(row.tool_call_id),
      toolName: optionalText(row.tool_name),
      text: String(row.excerpt),
      truncated: Boolean(row.cut),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function reportSession(
  sqlite: DatabaseSync,
  projectId: string,
  sessionId: string,
): ReportEvidence["session"] | null {
  // The project hint is not an authority. Enforce the pair before reading any report evidence.
  const row = sqlite
    .prepare("SELECT id, project_id, title FROM sessions WHERE id = ? AND project_id = ?")
    .get(sessionId, projectId);
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: optionalText(row.title),
  };
}

const section = <T>(items: T[], limit: number): EvidenceSection<T> => ({
  status: items.length ? "available" : "empty",
  truncated: items.length > limit,
  items: items.slice(0, limit),
});
const failed = <T>(): EvidenceSection<T> => ({ status: "failed", items: [], truncated: false });

function guarded<T>(load: () => EvidenceSection<T>): EvidenceSection<T> {
  try {
    return load();
  } catch {
    return failed();
  }
}

/** Read only bounded excerpts, not entire transcript blobs or unredacted provider wire output. */
export function collectReportEvidence(
  sqlite: DatabaseSync,
  session: ReportEvidence["session"],
  traceTasks: () => ReportEvidence["trace"]["items"],
): ReportEvidence {
  const runs: ReportEvidence["runs"] = guarded(() => {
    const rows = sqlite
      .prepare(
        `SELECT run_id, status, started_at, finished_at, substr(error, 1, ?) AS error,
          length(error) > ? AS error_cut FROM chat_runs
         WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(MAX_TEXT, MAX_TEXT, session.id, MAX_RUNS + 1);
    return section(
      rows.map((row) => ({
        runId: String(row.run_id),
        status: String(row.status),
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
        error: optionalText(row.error),
        truncated: Boolean(row.error_cut),
      })),
      MAX_RUNS,
    );
  });
  const approvals: ReportEvidence["approvals"] = guarded(() => {
    const rows = sqlite
      .prepare(
        `SELECT run_id, status, requested_at, resolved_at FROM chat_interrupts
         WHERE thread_id = ? ORDER BY requested_at DESC LIMIT 4`,
      )
      .all(session.id);
    return section(
      rows.map((row) => ({
        runId: String(row.run_id),
        status: String(row.status),
        requestedAt: Number(row.requested_at),
        resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      })),
      3,
    );
  });
  const excerpts = (kinds: readonly string[], limit: number) => {
    const slots = kinds.map(() => "?").join(", ");
    return sqlite
      .prepare(
        `SELECT id, kind, run_id, created_at, substr(text, 1, ?) AS excerpt,
          length(text) > ? AS cut,
          substr(json_extract(detail, '$.toolCallId'), 1, 128) AS tool_call_id,
          substr(json_extract(detail, '$.toolName'), 1, 128) AS tool_name,
          json_extract(detail, '$.ok') AS ok FROM nodes
         WHERE session_id = ? AND project_id = ? AND kind IN (${slots})
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(MAX_TEXT, MAX_TEXT, session.id, session.projectId, ...kinds, limit + 1);
  };
  const transcript: ReportEvidence["transcript"] = guarded(() =>
    section(
      excerpts(["user", "assistant"], MAX_TRANSCRIPT).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        runId: optionalText(row.run_id),
        createdAt: String(row.created_at),
        text: String(row.excerpt),
        truncated: Boolean(row.cut),
      })),
      MAX_TRANSCRIPT,
    ),
  );
  const calls: ReportEvidence["calls"] = guarded(() =>
    section(
      excerpts(["tool_call", "tool_result"], MAX_NODES).map((node) => ({
        id: String(node.id),
        kind: String(node.kind),
        runId: optionalText(node.run_id),
        toolCallId: optionalText(node.tool_call_id),
        toolName: optionalText(node.tool_name),
        ok: node.ok === null ? null : Boolean(node.ok),
        createdAt: String(node.created_at),
        text: String(node.excerpt),
        truncated: Boolean(node.cut),
      })),
      MAX_NODES,
    ),
  );
  const trace = guarded(() => section(traceTasks(), 5));
  return { session, runs, approvals, transcript, calls, trace };
}
