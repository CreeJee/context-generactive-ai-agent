import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import {
  collectReportEvidence,
  reportEvidenceItemResponse,
  reportEvidenceResponse,
  reportSession,
} from "./report-evidence";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE sessions(id TEXT, project_id TEXT, title TEXT);
    CREATE TABLE chat_runs(run_id TEXT, thread_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, error TEXT);
    CREATE TABLE chat_interrupts(run_id TEXT, thread_id TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER);
    CREATE TABLE nodes(id TEXT, kind TEXT, session_id TEXT, project_id TEXT, run_id TEXT, created_at TEXT, seq INTEGER, text TEXT, detail TEXT);
    INSERT INTO sessions VALUES ('s1', 'p1', 'bad approval');
    INSERT INTO sessions VALUES ('s2', 'p2', 'other project');
    INSERT INTO chat_runs VALUES ('r1', 's1', 'failed', 123, 456, 'network down');
    INSERT INTO chat_interrupts VALUES ('r1', 's1', 'pending', 124, NULL);
  `);
  return db;
}

describe("bounded report evidence", () => {
  test("HTTP response rejects missing and mismatched identifiers before exposing evidence", async () => {
    const db = fixture();
    try {
      const trace = () => {
        throw new Error("should not read trace");
      };
      expect(
        reportEvidenceResponse(db, new Request("http://localhost/api/reports/evidence"), trace)
          .status,
      ).toBe(400);
      for (const query of [
        "project=p2&session=s1",
        "project=p1&session=s2",
        "project=p1&session=missing",
      ]) {
        const denied = reportEvidenceResponse(
          db,
          new Request(`http://localhost/api/reports/evidence?${query}`),
          trace,
        );
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual({ error: "session_not_found" });
      }
      const allowed = reportEvidenceResponse(
        db,
        new Request("http://localhost/api/reports/evidence?project=p1&session=s1"),
        () => [],
      );
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      db.close();
    }
  });
  test("reads linked run, approval, transcript and call excerpts with caps", () => {
    const db = fixture();
    try {
      for (let i = 0; i < 20; i++) {
        db.prepare(
          "INSERT INTO nodes VALUES (?, 'tool_result', 's1', 'p1', 'r1', '2026-09-26', ?, ?, ?)",
        ).run(`n${i}`, i, "x".repeat(2000), JSON.stringify({ toolCallId: `call-${i}`, ok: false }));
      }
      db.prepare(
        "INSERT INTO nodes VALUES ('u1', 'user', 's1', 'p1', NULL, '2026-09-26', 21, 'approval loop', '{}')",
      ).run();
      const session = reportSession(db, "p1", "s1");
      expect(session).not.toBeNull();
      if (!session) throw new Error("missing fixture session");
      const result = collectReportEvidence(db, session, () => [
        {
          id: "t1",
          status: "failed",
          parentRunId: "r1",
          parentToolCallId: "call-1",
          updatedAt: 123,
        },
      ]);
      expect(result.runs.items[0]?.error).toBe("network down");
      expect(result.approvals.items[0]?.status).toBe("pending");
      expect(result.transcript.items[0]?.text).toBe("approval loop");
      expect(result.calls.items).toHaveLength(16);
      expect(result.calls.truncated).toBe(true);
      expect(result.calls.items[0]?.text).toHaveLength(1200);
      expect(result.calls.items[0]?.truncated).toBe(true);
      expect(result.calls.items[0]?.toolCallId).toBe("call-19");
      expect(result.trace.items[0]?.parentRunId).toBe("r1");
    } finally {
      db.close();
    }
  });

  test("does not merge another session's runs, calls, or transcript", () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sessions VALUES ('s3', 'p1', 'same project, other session');
        INSERT INTO chat_runs VALUES ('r3', 's3', 'failed', 999, NULL, 'other run');
        INSERT INTO nodes VALUES ('other', 'tool_result', 's3', 'p1', 'r3', '2026-09-26', 30, 'other call output', '{}');
        INSERT INTO nodes VALUES ('wrong-project', 'user', 's1', 'p2', NULL, '2026-09-26', 31, 'wrong project', '{}');
      `);
      const session = reportSession(db, "p1", "s1");
      if (!session) throw new Error("missing fixture session");
      const result = collectReportEvidence(db, session, () => []);
      expect(result.runs.items.map((run) => run.runId)).toEqual(["r1"]);
      expect(result.calls.status).toBe("empty");
      expect(result.transcript.status).toBe("empty");
    } finally {
      db.close();
    }
  });

  test("detailed tool output is bounded, source-bound and never exposes another kind", async () => {
    const db = fixture();
    try {
      db.prepare(
        "INSERT INTO nodes VALUES ('result', 'tool_result', 's1', 'p1', 'r1', '2026-09-26', 1, ?, ?)",
      ).run(
        "x".repeat(9000),
        JSON.stringify({ toolCallId: "call-1", toolName: "read", ok: false }),
      );
      db.prepare(
        "INSERT INTO nodes VALUES ('other', 'tool_result', 's2', 'p2', NULL, '2026-09-26', 2, 'private', '{}')",
      ).run();
      db.prepare(
        "INSERT INTO nodes VALUES ('user', 'user', 's1', 'p1', NULL, '2026-09-26', 3, 'not a tool output', '{}')",
      ).run();
      const get = (query: string) =>
        reportEvidenceItemResponse(
          db,
          new Request(`http://localhost/api/reports/evidence?${query}`),
        );
      const detail = get("project=p1&session=s1&item=result");
      expect(detail.status).toBe(200);
      expect(detail.headers.get("Cache-Control")).toBe("no-store");
      expect(await detail.json()).toMatchObject({
        id: "result",
        kind: "tool_result",
        toolCallId: "call-1",
        text: "x".repeat(8000),
        truncated: true,
      });
      for (const query of [
        "project=p1&session=s1&item=other",
        "project=p2&session=s1&item=result",
        "project=p1&session=s1&item=user",
      ]) {
        expect(get(query).status).toBe(404);
      }
      expect(get("project=p1&session=s1&item=").status).toBe(400);
    } finally {
      db.close();
    }
  });

  test("one broken evidence source does not block the other sections", () => {
    const db = fixture();
    try {
      db.exec("DROP TABLE chat_interrupts");
      const session = reportSession(db, "p1", "s1");
      if (!session) throw new Error("missing fixture session");
      const result = collectReportEvidence(db, session, () => {
        throw new Error("trace unavailable");
      });
      expect(result.runs.status).toBe("available");
      expect(result.approvals.status).toBe("failed");
      expect(result.trace.status).toBe("failed");
      expect(result.transcript.status).toBe("empty");
    } finally {
      db.close();
    }
  });
});
