import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "memory-agent";
import { openReportSession } from "./report-sessions";

const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
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
  Layer.provideMerge(NodeCrypto.layer),
);

const count = (table: "report_sessions" | "chat_runs") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table)}`;
    return row?.n;
  });

describe("dedicated report session", () => {
  it.layer(fixture)((it) => {
    it.effect("binds source on server and reuses the same separate session on repeat opens", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const first = yield* openReportSession("p1", "s1");
        expect(first?.reportSessionId).toBeTruthy();
        expect(first?.reportSessionId).not.toBe("s1");
        expect(yield* openReportSession("p1", "s1")).toEqual(first);
        expect(
          yield* sql`SELECT report_session_id AS "reportSessionId", source_session_id AS "sourceSessionId", project_id AS "projectId" FROM report_sessions`,
        ).toEqual([first]);
        expect(first).toMatchObject({ sourceSessionId: "s1", projectId: "p1" });
        expect(yield* count("report_sessions")).toBe(1);
        expect(yield* count("chat_runs")).toBe(0);
      }),
    );
  });

  it.layer(fixture)((it) => {
    it.effect("rejects cross-project, missing, and nested sources without creating a session", () =>
      Effect.gen(function* () {
        expect(yield* openReportSession("p2", "s1")).toBeNull();
        expect(yield* openReportSession("p1", "missing")).toBeNull();
        const first = yield* openReportSession("p1", "s1");
        expect(yield* openReportSession("p1", first?.reportSessionId ?? "")).toBeNull();
        expect(yield* count("report_sessions")).toBe(1);
      }),
    );
  });
});
