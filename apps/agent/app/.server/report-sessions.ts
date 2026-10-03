import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ReportSessionBinding {
  reportSessionId: string;
  sourceSessionId: string;
  projectId: string;
}

/** Single SQLite transaction: repeat clicks/tabs cannot create competing report sessions. */
export function openReportSession(
  sqlite: DatabaseSync,
  projectId: string,
  sourceSessionId: string,
): ReportSessionBinding | null {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const source = sqlite
      .prepare(
        `SELECT s.id FROM sessions s WHERE s.id = ? AND s.project_id = ?
       AND NOT EXISTS (SELECT 1 FROM report_sessions r WHERE r.report_session_id = s.id)`,
      )
      .get(sourceSessionId, projectId);
    if (!source) {
      sqlite.exec("ROLLBACK");
      return null;
    }
    let row = sqlite
      .prepare(
        "SELECT report_session_id FROM report_sessions WHERE source_session_id = ? AND project_id = ?",
      )
      .get(sourceSessionId, projectId);
    if (!row) {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      sqlite
        .prepare("INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)")
        .run(id, projectId, "문제 제보 분석", createdAt);
      sqlite
        .prepare(
          `INSERT INTO report_sessions (report_session_id, source_session_id, project_id, created_at)
         VALUES (?, ?, ?, ?)`,
        )
        .run(id, sourceSessionId, projectId, createdAt);
      row = { report_session_id: id };
    }
    sqlite.exec("COMMIT");
    return { reportSessionId: String(row.report_session_id), sourceSessionId, projectId };
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
