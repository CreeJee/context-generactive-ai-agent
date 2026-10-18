import { it } from "@effect/vitest";
import { isTruthy } from "../src/truthy.ts";
import { Cause, Effect, Option, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vite-plus/test";
import { connectionContext } from "../src/db/database.ts";
import { SqlClient } from "effect/sql";
import {
  initialReportEvidence,
  reportBinding,
  reportToolsForSession,
} from "../src/tools/report-evidence.ts";

const redactSecret = (text: string) => Effect.succeed(text.replaceAll("SECRET", "[redacted]"));
const keep = (text: string) => Effect.succeed(text);

/** Run a report Effect over `db`, as the owner composition root supplies its SqlClient. */
const over =
  (db: DatabaseSync) =>
  <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.flatMap(connectionContext(db), (context) => Effect.provideContext(effect, context));

const fixture = Effect.gen(function* () {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (db) => Effect.sync(() => db.close()),
  );
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
  const tools = yield* over(db)(
    reportToolsForSession("report", "p", redactSecret, () => [
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
    ]),
  );
  const invoke = (name: string, input: Schema.Json) =>
    Effect.tryPromise({
      try: () => {
        const tool = tools.find((entry) => entry.name === name);
        if (!isTruthy(tool?.execute)) throw new Error(`Missing tool ${name}`);
        // SAFETY: each tool server decodes its own input schema, including invalid-input test cases.
        return Promise.resolve(tool.execute(input as never));
      },
      catch: (cause) => new Cause.UnknownError(cause),
    });
  return { db, tools, invoke };
});

describe("report evidence tools", () => {
  it.effect("exposes only two bound read tools, without mutation or arbitrary search", () =>
    Effect.gen(function* () {
      const { tools } = yield* fixture;
      expect(tools.map((tool) => tool.name)).toEqual(["list_report_evidence", "read_report_item"]);
    }),
  );

  it.effect("binding validates both session projects and refuses forged bindings", () =>
    Effect.gen(function* () {
      const { db } = yield* fixture;
      const read = over(db);
      expect(yield* read(reportBinding("report", "p"))).toEqual(
        Option.some({ sourceSessionId: "source", reportSessionId: "report", projectId: "p" }),
      );
      expect(yield* read(reportBinding("report", "q"))).toEqual(Option.none());
      expect(yield* read(reportBinding("bad-report", "p"))).toEqual(Option.none());
      expect(yield* read(reportToolsForSession("bad-report", "p", keep, () => []))).toEqual([]);
    }),
  );

  it.effect("cannot read other sessions, projects or arbitrary ids", () =>
    Effect.gen(function* () {
      const { invoke } = yield* fixture;
      for (const [section, id] of [
        ["run", "other-run"],
        ["approval", "2"],
        ["approval", "1xyz"],
        ["node", "other-node"],
        ["node", "foreign-node"],
        ["trace", "foreign-task"],
        ["node", "unknown"],
      ]) {
        expect(yield* invoke("read_report_item", { section, id })).toEqual({ error: "not_found" });
      }
      expect(
        (yield* Effect.flip(
          Effect.asVoid(invoke("list_report_evidence", { section: "calls", offset: 201 })),
        )).cause,
      ).toBeInstanceOf(Error);
    }),
  );

  it.effect(
    "initial context contains bounded source calls/results, gaps, and redacted provenance",
    () =>
      Effect.gen(function* () {
        const { db } = yield* fixture;
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
        const context = yield* over(db)(
          initialReportEvidence("report", "p", redactSecret, () => [
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
          ]),
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
        const missing = yield* over(db)(initialReportEvidence("report", "p", keep, () => []));
        expect(missing).toContain("approvals: failed");
      }),
  );

  it.effect("revoking or rebinding the source invalidates an already issued tool", () =>
    Effect.gen(function* () {
      const { db, invoke } = yield* fixture;
      db.exec(
        "UPDATE report_sessions SET source_session_id = 'other' WHERE report_session_id = 'report'",
      );
      expect(yield* invoke("read_report_item", { section: "node", id: "call" })).toEqual({
        error: "not_found",
      });
      expect(yield* invoke("list_report_evidence", { section: "calls", offset: 0 })).toEqual({
        error: "not_found",
      });
    }),
  );

  it.effect("read and list cap text, redact it and attribute calls and status/time", () =>
    Effect.gen(function* () {
      const { invoke } = yield* fixture;
      const call = yield* invoke("read_report_item", { section: "node", id: "result" });
      expect(call).toMatchObject({
        id: "result",
        section: "node",
        status: "tool_result",
        time: "2026-01-02",
        toolCallId: "call-1",
        text: "[redacted] result",
        truncated: false,
      });
      const approval = yield* invoke("read_report_item", { section: "approval", id: "1" });
      expect(approval.text).toContain("[redacted]");
      expect(approval.toolCallId).toBe("call-1");
      const run = yield* invoke("read_report_item", { section: "run", id: "run" });
      expect(run).toMatchObject({ status: "failed", time: 10, text: "[redacted] failure" });
      const long = yield* invoke("read_report_item", { section: "node", id: "long" });
      expect(long.text).toHaveLength(8000);
      expect(long.truncated).toBe(true);
      const calls = yield* invoke("list_report_evidence", { section: "calls" });
      expect(calls.items.map((item: { id: string }) => item.id)).toEqual(["result", "call"]);
      expect(calls.items[0].toolCallId).toBe("call-1");
      const trace = yield* invoke("read_report_item", { section: "trace", id: "task" });
      expect(trace.text).toContain("[redacted] request");
      expect(trace.toolCallId).toBe("call-1");
      expect((yield* invoke("list_report_evidence", { section: "trace" })).items).toHaveLength(1);
    }),
  );
});
