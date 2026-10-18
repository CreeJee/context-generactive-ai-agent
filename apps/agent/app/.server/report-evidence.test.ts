import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "memory-agent";
import {
  collectReportEvidence,
  reportEvidenceItemResponse,
  reportEvidenceResponse,
  reportSession,
} from "./report-evidence";

const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE sessions(id TEXT, project_id TEXT, title TEXT);
      CREATE TABLE chat_runs(run_id TEXT, thread_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, error TEXT);
      CREATE TABLE chat_interrupts(run_id TEXT, thread_id TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER);
      CREATE TABLE nodes(id TEXT, kind TEXT, session_id TEXT, project_id TEXT, run_id TEXT, created_at TEXT, seq INTEGER, text TEXT, detail TEXT);
      INSERT INTO sessions VALUES ('s1', 'p1', 'bad approval');
      INSERT INTO sessions VALUES ('s2', 'p2', 'other project');
      INSERT INTO chat_runs VALUES ('r1', 's1', 'failed', 123, 456, 'network down');
      INSERT INTO chat_interrupts VALUES ('r1', 's1', 'pending', 124, NULL);
    `).unprepared;
  }),
).pipe(
  Layer.provideMerge(
    Database.over(
      Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(":memory:")),
        (db) => Effect.sync(() => db.close()),
      ),
    ),
  ),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const insertNode = Effect.fnUntraced(function* (...values: ReadonlyArray<string | number | null>) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", values);
});
const json = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new Cause.UnknownError(cause),
  });
const session = Effect.flatMap(reportSession("p1", "s1"), (found) =>
  Option.match(found, {
    onNone: () => Effect.die("missing fixture session"),
    onSome: Effect.succeed,
  }),
);
const noTrace = Effect.succeed([]);

describe("bounded report evidence", () => {
  it.layer(fixture)((it) => {
    it.effect(
      "HTTP response rejects missing and mismatched identifiers before exposing evidence",
      () =>
        Effect.gen(function* () {
          const trace = () => Effect.die("should not read trace");
          expect(
            (yield* reportEvidenceResponse(
              new Request("http://localhost/api/reports/evidence"),
              trace,
            )).status,
          ).toBe(400);
          for (const query of [
            "project=p2&session=s1",
            "project=p1&session=s2",
            "project=p1&session=missing",
          ]) {
            const denied = yield* reportEvidenceResponse(
              new Request(`http://localhost/api/reports/evidence?${query}`),
              trace,
            );
            expect(denied.status).toBe(404);
            expect(yield* json(denied)).toEqual({ error: "session_not_found" });
          }
          const allowed = yield* reportEvidenceResponse(
            new Request("http://localhost/api/reports/evidence?project=p1&session=s1"),
            () => noTrace,
          );
          expect(allowed.status).toBe(200);
          expect(allowed.headers.get("Cache-Control")).toBe("no-store");
        }),
    );
  });

  it.layer(fixture)((it) => {
    it.effect("reads linked run, approval, transcript and call excerpts with caps", () =>
      Effect.gen(function* () {
        for (let i = 0; i < 20; i++)
          yield* insertNode(
            `n${i}`,
            "tool_result",
            "s1",
            "p1",
            "r1",
            "2026-09-26",
            i,
            "x".repeat(2000),
            yield* encodeJson({ toolCallId: `call-${i}`, ok: false }),
          );
        yield* insertNode("u1", "user", "s1", "p1", null, "2026-09-26", 21, "approval loop", "{}");
        const result = yield* collectReportEvidence(
          yield* session,
          Effect.succeed([
            {
              id: "t1",
              status: "failed",
              parentRunId: "r1",
              parentToolCallId: "call-1",
              updatedAt: 123,
            },
          ]),
        );
        expect(result.runs.items[0]?.error).toBe("network down");
        expect(result.approvals.items[0]?.status).toBe("pending");
        expect(result.transcript.items[0]?.text).toBe("approval loop");
        expect(result.calls.items).toHaveLength(16);
        expect(result.calls.truncated).toBe(true);
        expect(result.calls.items[0]?.text).toHaveLength(1200);
        expect(result.calls.items[0]?.truncated).toBe(true);
        expect(result.calls.items[0]?.toolCallId).toBe("call-19");
        expect(result.trace.items[0]?.parentRunId).toBe("r1");
      }),
    );
  });

  it.layer(fixture)((it) => {
    it.effect("does not merge another session's runs, calls, or transcript", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`
          INSERT INTO sessions VALUES ('s3', 'p1', 'same project, other session');
          INSERT INTO chat_runs VALUES ('r3', 's3', 'failed', 999, NULL, 'other run');
          INSERT INTO nodes VALUES ('other', 'tool_result', 's3', 'p1', 'r3', '2026-09-26', 30, 'other call output', '{}');
          INSERT INTO nodes VALUES ('wrong-project', 'user', 's1', 'p2', NULL, '2026-09-26', 31, 'wrong project', '{}');
        `).unprepared;
        const result = yield* collectReportEvidence(yield* session, noTrace);
        expect(result.runs.items.map((run) => run.runId)).toEqual(["r1"]);
        expect(result.calls.status).toBe("empty");
        expect(result.transcript.status).toBe("empty");
      }),
    );
  });

  it.layer(fixture)((it) => {
    it.effect("detailed tool output is bounded, source-bound and never exposes another kind", () =>
      Effect.gen(function* () {
        yield* insertNode(
          "result",
          "tool_result",
          "s1",
          "p1",
          "r1",
          "2026-09-26",
          1,
          "x".repeat(9000),
          yield* encodeJson({ toolCallId: "call-1", toolName: "read", ok: false }),
        );
        yield* insertNode(
          "other",
          "tool_result",
          "s2",
          "p2",
          null,
          "2026-09-26",
          2,
          "private",
          "{}",
        );
        yield* insertNode(
          "user",
          "user",
          "s1",
          "p1",
          null,
          "2026-09-26",
          3,
          "not a tool output",
          "{}",
        );
        const get = (query: string) =>
          reportEvidenceItemResponse(new Request(`http://localhost/api/reports/evidence?${query}`));
        const detail = yield* get("project=p1&session=s1&item=result");
        expect(detail.status).toBe(200);
        expect(detail.headers.get("Cache-Control")).toBe("no-store");
        expect(yield* json(detail)).toMatchObject({
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
        ])
          expect((yield* get(query)).status).toBe(404);
        expect((yield* get("project=p1&session=s1&item=")).status).toBe(400);
      }),
    );
  });

  it.layer(fixture)((it) => {
    it.effect("one broken evidence source does not block the other sections", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE chat_interrupts`;
        const result = yield* collectReportEvidence(
          yield* session,
          Effect.fail(new Cause.UnknownError(undefined, "trace unavailable")),
        );
        expect(result.runs.status).toBe("available");
        expect(result.approvals.status).toBe("failed");
        expect(result.trace.status).toBe("failed");
        expect(result.transcript.status).toBe("empty");
      }),
    );
  });
});
