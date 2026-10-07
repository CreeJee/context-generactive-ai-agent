import { isTruthy } from "../truthy.ts";
import { Crypto, DateTime, Effect, Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";

export interface ReportSessionBinding {
  reportSessionId: string;
  sourceSessionId: string;
  projectId: string;
}

export class ReportSessionFailed extends Schema.TaggedError<ReportSessionFailed>()(
  "ReportSessionFailed",
  { cause: Schema.Defect() },
) {}

/** Single SQLite transaction: repeat clicks/tabs cannot create competing report sessions. */
export const openReportSession = Effect.fn("openReportSession")(function* (
  sqlite: DatabaseSync,
  projectId: string,
  sourceSessionId: string,
) {
  const id = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.try({
    try: (): ReportSessionBinding | null => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const source = sqlite
          .prepare(
            `SELECT s.id FROM sessions s WHERE s.id = ? AND s.project_id = ?
       AND NOT EXISTS (SELECT 1 FROM report_sessions r WHERE r.report_session_id = s.id)`,
          )
          .get(sourceSessionId, projectId);
        if (!isTruthy(source)) {
          sqlite.exec("ROLLBACK");
          return null;
        }
        let row = sqlite
          .prepare(
            "SELECT report_session_id FROM report_sessions WHERE source_session_id = ? AND project_id = ?",
          )
          .get(sourceSessionId, projectId);
        if (!isTruthy(row)) {
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
    },
    catch: (cause) => ReportSessionFailed.make({ cause }),
  });
});
