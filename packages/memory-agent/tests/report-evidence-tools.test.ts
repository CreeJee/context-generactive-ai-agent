import { Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import {
  initialReportEvidence,
  reportBinding,
  reportToolsForSession,
} from "../src/tools/report-evidence.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE report_sessions(report_session_id TEXT PRIMARY KEY, source_session_id TEXT, project_id TEXT);
    CREATE TABLE chat_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT, started_at INTEGER, error TEXT);
    CREATE TABLE permission_reviews(id INTEGER PRIMARY KEY, session_id TEXT, decision TEXT, created_at TEXT, reason TEXT, tool_name TEXT, input TEXT, tool_call_id TEXT);
    CREATE TABLE nodes(id TEXT PRIMARY KEY, seq INTEGER, session_id TEXT, project_id TEXT, kind TEXT, created_at TEXT, text TEXT, detail TEXT);
    INSERT INTO sessions VALUES ('source','p'),('report','p'),('other','p'),('foreign','q'),('bad-report','q');
    INSERT INTO report_sessions VALUES ('report','source','p'),('bad-report','source','p');
    INSERT INTO chat_runs VALUES ('run','source','failed',10,'SECRET failure'),('other-run','other','failed',11,'private');
    INSERT INTO permission_reviews VALUES (1,'source','denied','2026-01-01','SECRET reason','write_file','{"path":"SECRET"}','call-1'),(2,'other','denied','2026-01-02','private','write_file','{}','call-2');
    INSERT INTO nodes VALUES ('call',1,'source','p','tool_call','2026-01-01','SECRET invocation','{"toolCallId":"call-1"}'),
      ('result',2,'source','p','tool_result','2026-01-02','SECRET result','{"toolCallId":"call-1","untrusted":"SECRET"}'),
      ('long',3,'source','p','assistant','2026-01-03','${"x".repeat(9000)}','{}'),
      ('other-node',4,'other','p','tool_result','2026-01-04','private','{}'),
      ('foreign-node',5,'source','q','tool_result','2026-01-05','private','{}');
    ALTER TABLE nodes ADD COLUMN run_id TEXT;`);
  const tools = reportToolsForSession(
    db,
    "report",
    "p",
    async (text) => text.replaceAll("SECRET", "[redacted]"),
    () => [
      {
        id: "task",
        projectId: "p",
        originSessionId: "source",
        status: "failed",
        title: "SECRET trace",
        request: "SECRET request",
        parentToolCallId: "call-1",
        createdAt: 12,
      },
      {
        id: "foreign-task",
        projectId: "q",
        originSessionId: "foreign",
        status: "failed",
        title: "private",
        request: "private",
        parentToolCallId: "x",
        createdAt: 13,
      },
    ],
  );
  const invoke = async (name: string, input: Schema.Json): Promise<any> => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool?.execute) throw new Error(`Missing tool ${name}`);
    // SAFETY: each tool server decodes its own input schema, including invalid-input test cases.
    return tool.execute(input as never);
  };
  return { db, tools, invoke };
}

describe("report evidence tools", () => {
  test("exposes only two bound read tools, without mutation or arbitrary search", () => {
    const { db, tools } = fixture();
    expect(tools.map((tool) => tool.name)).toEqual(["list_report_evidence", "read_report_item"]);
    db.close();
  });

  test("binding validates both session projects and refuses forged bindings", () => {
    const { db } = fixture();
    expect(reportBinding(db, "report", "p")).toEqual({
      sourceSessionId: "source",
      reportSessionId: "report",
      projectId: "p",
    });
    expect(reportBinding(db, "report", "q")).toBeNull();
    expect(reportBinding(db, "bad-report", "p")).toBeNull();
    expect(
      reportToolsForSession(
        db,
        "bad-report",
        "p",
        async (x) => x,
        () => [],
      ),
    ).toEqual([]);
    db.close();
  });

  test("cannot read other sessions, projects or arbitrary ids", async () => {
    const { db, invoke } = fixture();
    for (const [section, id] of [
      ["run", "other-run"],
      ["approval", "2"],
      ["approval", "1xyz"],
      ["node", "other-node"],
      ["node", "foreign-node"],
      ["trace", "foreign-task"],
      ["node", "unknown"],
    ]) {
      expect(await invoke("read_report_item", { section, id })).toEqual({ error: "not_found" });
    }
    await expect(
      invoke("list_report_evidence", { section: "calls", offset: 201 }),
    ).rejects.toThrow();
    db.close();
  });

  test("initial context contains bounded source calls/results, gaps, and redacted provenance", async () => {
    const { db } = fixture();
    db.prepare(
      'UPDATE nodes SET detail = \'{"toolCallId":"call-1","ok":false}\' WHERE id = \'result\'',
    ).run();
    for (let i = 0; i < 15; i++) {
      db.prepare(
        "INSERT INTO nodes(id,seq,session_id,project_id,kind,created_at,text,detail) VALUES (?,?, 'source','p','tool_result','2026-01-06','recent success','{\"ok\":true}')",
      ).run(`success-${i}`, 10 + i);
    }
    db.prepare(
      "INSERT INTO nodes(id,seq,session_id,project_id,kind,created_at,text,detail) VALUES ('failed',0,'source','p','tool_result','2026-01-01','old failed output','{\"ok\":false}')",
    ).run();
    const context = await initialReportEvidence(
      db,
      "report",
      "p",
      async (text) => text.replaceAll("SECRET", "[redacted]"),
      () => [
        {
          id: "source-task",
          projectId: "p",
          originSessionId: "source",
          status: "failed",
          title: "SECRET trace",
          request: "",
          parentToolCallId: "call-1",
          createdAt: 12,
        },
        {
          id: "private-task",
          projectId: "q",
          originSessionId: "foreign",
          status: "failed",
          title: "private",
          request: "",
          parentToolCallId: "x",
          createdAt: 13,
        },
      ],
    );
    expect(context).toContain("old failed output");
    expect(context).toContain("[redacted] result");
    expect(context).not.toContain("[redacted] invocation");
    expect(context).toContain("toolCallId");
    expect(context).toContain("source-task");
    expect(context).toContain("transcript: available");
    expect(context).not.toContain("SECRET");
    expect(context).not.toContain("private");
    expect(context.length).toBeLessThanOrEqual(20_100);
    db.exec("DROP TABLE permission_reviews");
    const missing = await initialReportEvidence(
      db,
      "report",
      "p",
      async (x) => x,
      () => [],
    );
    expect(missing).toContain("approvals: failed");
    db.close();
  });

  test("revoking or rebinding the source invalidates an already issued tool", async () => {
    const { db, invoke } = fixture();
    db.exec(
      "UPDATE report_sessions SET source_session_id = 'other' WHERE report_session_id = 'report'",
    );
    expect(await invoke("read_report_item", { section: "node", id: "call" })).toEqual({
      error: "not_found",
    });
    expect(await invoke("list_report_evidence", { section: "calls", offset: 0 })).toEqual({
      error: "not_found",
    });
    db.close();
  });

  test("read and list cap text, redact it and attribute calls and status/time", async () => {
    const { db, invoke } = fixture();
    const call = await invoke("read_report_item", { section: "node", id: "result" });
    expect(call).toMatchObject({
      id: "result",
      section: "node",
      status: "tool_result",
      time: "2026-01-02",
      toolCallId: "call-1",
      text: "[redacted] result",
      truncated: false,
    });
    const approval = await invoke("read_report_item", { section: "approval", id: "1" });
    expect(approval.text).toContain("[redacted]");
    expect(approval.toolCallId).toBe("call-1");
    const run = await invoke("read_report_item", { section: "run", id: "run" });
    expect(run).toMatchObject({ status: "failed", time: 10, text: "[redacted] failure" });
    const long = await invoke("read_report_item", { section: "node", id: "long" });
    expect(long.text).toHaveLength(8000);
    expect(long.truncated).toBe(true);
    const calls = await invoke("list_report_evidence", { section: "calls" });
    expect(calls.items.map((item: { id: string }) => item.id)).toEqual(["result", "call"]);
    expect(calls.items[0].toolCallId).toBe("call-1");
    const trace = await invoke("read_report_item", { section: "trace", id: "task" });
    expect(trace.text).toContain("[redacted] request");
    expect(trace.toolCallId).toBe("call-1");
    expect((await invoke("list_report_evidence", { section: "trace" })).items).toHaveLength(1);
    db.close();
  });
});
