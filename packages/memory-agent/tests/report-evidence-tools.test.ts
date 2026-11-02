import { it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { SqlClient } from "effect/sql";
import type { JsonValue } from "../src/json.ts";
import {
  initialReportEvidence,
  reportBinding,
  reportRunToolsForSession,
} from "../src/tools/report-evidence.ts";
import { callTool } from "./support/run-tools.ts";
import { sqlExec } from "./support/sql.ts";

const redactSecret = (text: string) => Effect.succeed(text.replaceAll("SECRET", "[redacted]"));
const keep = (text: string) => Effect.succeed(text);

const fixture = Effect.gen(function* () {
  const database = yield* Layer.build(Database.layer(":memory:"));
  /** Run a report Effect over the migrated database, as the owner supplies its SqlClient. */
  const over = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideContext(effect, database);
  yield* over(
    sqlExec(`INSERT INTO projects (id, root, name, created_at) VALUES ('p','/p','p','2026-01-01'),('q','/q','q','2026-01-01');
    INSERT INTO sessions (id, project_id, created_at) VALUES ('source','p','2026-01-01'),('report','p','2026-01-01'),('other','p','2026-01-01'),('foreign','q','2026-01-01'),('bad-report','q','2026-01-01');
    INSERT INTO report_sessions (report_session_id, source_session_id, project_id, created_at) VALUES ('report','source','p','2026-01-01'),('bad-report','foreign','p','2026-01-01');
    INSERT INTO chat_runs (run_id, thread_id, status, started_at, error) VALUES ('run','source','failed',10,'SECRET failure'),('other-run','other','failed',11,'private');
    INSERT INTO permission_reviews (id, session_id, tool_call_id, tool_name, input, decision, decided_by, reason, created_at) VALUES (1,'source','call-1','write_file','{"path":"SECRET"}','denied','user','SECRET reason','2026-01-01'),(2,'other','call-2','write_file','{}','denied','user','private','2026-01-02');
    INSERT INTO nodes (id, session_id, project_id, kind, created_at, text, detail) VALUES ('call','source','p','tool_call','2026-01-01','SECRET invocation','{"toolCallId":"call-1"}'),
      ('result','source','p','tool_result','2026-01-02','SECRET result','{"toolCallId":"call-1","ok":false,"untrusted":"SECRET"}'),
      ('long','source','p','assistant','2026-01-03','${"x".repeat(9000)}','{}'),
      ('other-node','other','p','tool_result','2026-01-04','private','{}'),
      ('foreign-node','source','q','tool_result','2026-01-05','private','{}');`),
  );
  const tools = yield* over(
    reportRunToolsForSession(
      "report",
      "p",
      redactSecret,
      Effect.succeed([
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
    ),
  );
  const invoke = (name: string, input: JsonValue) => callTool(tools, name, input);
  return { over, tools, invoke };
});

describe("report evidence tools", () => {
  it.effect("exposes only two bound read tools, without mutation or arbitrary search", () =>
    Effect.gen(function* () {
      const { tools } = yield* fixture;
      expect(tools.map(({ tool }) => tool.name)).toEqual([
        "list_report_evidence",
        "read_report_item",
      ]);
    }),
  );

  it.effect("binding validates both session projects and refuses forged bindings", () =>
    Effect.gen(function* () {
      const { over: read } = yield* fixture;
      expect(yield* read(reportBinding("report", "p"))).toEqual(
        Option.some({ sourceSessionId: "source", reportSessionId: "report", projectId: "p" }),
      );
      expect(yield* read(reportBinding("report", "q"))).toEqual(Option.none());
      expect(yield* read(reportBinding("bad-report", "p"))).toEqual(Option.none());
      expect(
        yield* read(reportRunToolsForSession("bad-report", "p", keep, Effect.succeed([]))),
      ).toEqual([]);
    }),
  );

  it.effect("cannot read other sessions, projects or arbitrary ids", () =>
    Effect.gen(function* () {
      const { invoke } = yield* fixture;
      yield* Effect.forEach(
        [
          ["run", "other-run"],
          ["approval", "2"],
          ["approval", "1xyz"],
          ["node", "other-node"],
          ["node", "foreign-node"],
          ["trace", "foreign-task"],
          ["node", "unknown"],
        ],
        ([section, id]) =>
          Effect.map(invoke("read_report_item", { section, id }), (result) =>
            expect(result).toEqual({ error: "not_found" }),
          ),
        { discard: true },
      );
      expect(
        yield* Effect.flip(invoke("list_report_evidence", { section: "calls", offset: 201 })),
      ).toBeInstanceOf(Schema.SchemaError);
    }),
  );

  it.effect(
    "initial context contains bounded source calls/results, gaps, and redacted provenance",
    () =>
      Effect.gen(function* () {
        const { over } = yield* fixture;
        yield* over(
          sqlExec(`INSERT INTO nodes (id, session_id, project_id, kind, created_at, text, detail) VALUES ('failed','source','p','tool_result','2026-01-01','old failed output','{"ok":false}'),
            ${Array.from({ length: 15 }, (_, i) => `('success-${i}','source','p','tool_result','2026-01-06','recent success','{"ok":true}')`).join(",")};`),
        );
        const context = yield* over(
          initialReportEvidence(
            "report",
            "p",
            redactSecret,
            Effect.succeed([
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
          ),
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
        yield* over(sqlExec("DROP TABLE permission_reviews"));
        const missing = yield* over(initialReportEvidence("report", "p", keep, Effect.succeed([])));
        expect(missing).toContain("approvals: failed");
      }),
  );

  it.effect("revoking or rebinding the source invalidates an already issued tool", () =>
    Effect.gen(function* () {
      const { over, invoke } = yield* fixture;
      yield* over(
        sqlExec(
          "UPDATE report_sessions SET source_session_id = 'other' WHERE report_session_id = 'report'",
        ),
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
      expect(yield* invoke("read_report_item", { section: "approval", id: "1" })).toMatchObject({
        text: expect.stringContaining("[redacted]"),
        toolCallId: "call-1",
      });
      const run = yield* invoke("read_report_item", { section: "run", id: "run" });
      expect(run).toMatchObject({ status: "failed", time: 10, text: "[redacted] failure" });
      expect(yield* invoke("read_report_item", { section: "node", id: "long" })).toMatchObject({
        text: expect.stringMatching(/^[\s\S]{8000}$/),
        truncated: true,
      });
      expect(yield* invoke("list_report_evidence", { section: "calls" })).toMatchObject({
        items: [{ id: "result", toolCallId: "call-1" }, { id: "call" }],
      });
      expect(yield* invoke("read_report_item", { section: "trace", id: "task" })).toMatchObject({
        text: expect.stringContaining("[redacted] request"),
        toolCallId: "call-1",
      });
      expect(yield* invoke("list_report_evidence", { section: "trace" })).toMatchObject({
        items: [expect.anything()],
      });
    }),
  );
});
