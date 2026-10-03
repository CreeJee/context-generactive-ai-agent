import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { openReportSession } from "./report-sessions";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT, created_at TEXT NOT NULL);
    CREATE TABLE chat_runs(run_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE report_sessions(report_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      source_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL,
      CHECK (report_session_id <> source_session_id));
    INSERT INTO projects VALUES ('p1'), ('p2');
    INSERT INTO sessions VALUES ('s1', 'p1', NULL, 'now'), ('s2', 'p1', NULL, 'now'), ('s3', 'p2', NULL, 'now');
  `);
  return db;
}

describe("dedicated report session", () => {
  test("binds source on server and reuses the same separate session on repeat opens", () => {
    const db = fixture();
    try {
      const first = openReportSession(db, "p1", "s1");
      expect(first?.reportSessionId).toBeTruthy();
      expect(first?.reportSessionId).not.toBe("s1");
      expect(openReportSession(db, "p1", "s1")).toEqual(first);
      expect(
        db
          .prepare(
            "SELECT report_session_id AS reportSessionId, source_session_id AS sourceSessionId, project_id AS projectId FROM report_sessions",
          )
          .get(),
      ).toEqual(first);
      expect(first).toMatchObject({ sourceSessionId: "s1", projectId: "p1" });
      expect(db.prepare("SELECT count(*) AS n FROM report_sessions").get()?.n).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM chat_runs").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("rejects cross-project, missing, and nested sources without creating a session", () => {
    const db = fixture();
    try {
      expect(openReportSession(db, "p2", "s1")).toBeNull();
      expect(openReportSession(db, "p1", "missing")).toBeNull();
      const first = openReportSession(db, "p1", "s1");
      expect(openReportSession(db, "p1", first?.reportSessionId ?? "")).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM report_sessions").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
