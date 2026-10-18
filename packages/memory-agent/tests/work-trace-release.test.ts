import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { SqlClient } from "effect/sql";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

const QueryPlanRow = Schema.Struct({ detail: Schema.String });
const planDetails = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(QueryPlanRow))(rows).pipe(
    Effect.map((decoded) => decoded.map((row) => row.detail).join("\n")),
  );

testAgent()("Work Trace release limits", (it) => {
  it.effect(
    "uses covering indexes and projects 1,000 live tasks within the release budget",
    () =>
      Effect.gen(function* () {
        const { project, session } = yield* TestEnv;
        const sql = yield* SqlClient.SqlClient;
        const trace = yield* WorkTraceStore;
        yield* sql`INSERT INTO subagents
          (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
          VALUES ('scale-agent', ${session.id}, 'scale-agent', 'test', 'running', 'scale-parent',
            'test', 1, 1)`;

        yield* Effect.forEach(
          Array.from({ length: 1_000 }, (_, index) => index),
          (index) =>
            trace.startAttempt({
              sessionId: session.id,
              parentRunId: "scale-parent",
              parentToolCallId: `scale-call-${index}`,
              agentId: "scale-agent",
              title: `Task ${index}`,
              request: "Measure indexed projection",
              kind: "start",
              threadId: `scale-thread-${index}`,
            }),
          { discard: true },
        ).pipe(sql.withTransaction);

        const projectPlan = yield* planDetails(
          yield* sql`EXPLAIN QUERY PLAN SELECT * FROM work_tasks
            WHERE project_id = ${project.id} ORDER BY created_at, id`,
        );
        const eventPlan = yield* planDetails(
          yield* sql`EXPLAIN QUERY PLAN SELECT * FROM run_events
            WHERE origin_session_id = ${session.id} AND seq > ${0} ORDER BY seq`,
        );
        expect(projectPlan).toContain("work_tasks_project");
        expect(eventPlan).toContain("run_events_origin_cursor");

        // Warm SQLite's page cache before measuring the user-facing projections.
        yield* trace.projectTaskTree(project.id);
        yield* trace.snapshot(session.id, 0);
        const started = performance.now();
        const tasks = yield* trace.projectTaskTree(project.id);
        const snapshot = yield* trace.snapshot(session.id, 0);
        const elapsedMs = performance.now() - started;
        expect(tasks).toHaveLength(1_000);
        // Replay is deliberately page-bounded even when the durable cursor contains more events.
        expect(snapshot.events).toHaveLength(500);
        expect(snapshot.cursor).toBe(500);
        expect(elapsedMs).toBeLessThan(1_000);
      }),
    10_000,
  );
});
