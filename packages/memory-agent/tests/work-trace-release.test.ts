import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { testRuntime } from "./support/runtime.ts";

const QueryPlanRow = Schema.Struct({ detail: Schema.String });
const decodeQueryPlanRow = Schema.decodeUnknownSync(QueryPlanRow);
const planDetails = (rows: readonly unknown[]) =>
  rows
    .map((row) => decodeQueryPlanRow(row))
    .map((row) => row.detail)
    .join("\n");

describe("Work Trace release limits", () => {
  test("uses covering indexes and projects 1,000 live tasks within the release budget", async () => {
    const { runtime, project, session } = await testRuntime();
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        const trace = yield* WorkTraceStore;
        db.sqlite
          .prepare(`INSERT INTO subagents
            (id, session_id, name, instructions, status, parent_run_id, last_task, created_at, updated_at)
            VALUES ('scale-agent', ?, 'scale-agent', 'test', 'running', 'scale-parent', 'test', 1, 1)`)
          .run(session.id);

        for (let index = 0; index < 1_000; index += 1)
          trace.startAttempt({
            sessionId: session.id,
            parentRunId: "scale-parent",
            parentToolCallId: `scale-call-${index}`,
            agentId: "scale-agent",
            title: `Task ${index}`,
            request: "Measure indexed projection",
            kind: "start",
            threadId: `scale-thread-${index}`,
          });

        const projectPlan = planDetails(
          db.sqlite
            .prepare(
              "EXPLAIN QUERY PLAN SELECT * FROM work_tasks WHERE project_id = ? ORDER BY created_at, id",
            )
            .all(project.id),
        );
        const eventPlan = planDetails(
          db.sqlite
            .prepare(
              "EXPLAIN QUERY PLAN SELECT * FROM run_events WHERE origin_session_id = ? AND seq > ? ORDER BY seq",
            )
            .all(session.id, 0),
        );
        expect(projectPlan).toContain("work_tasks_project");
        expect(eventPlan).toContain("run_events_origin_cursor");

        // Warm SQLite's page cache before measuring the user-facing projections.
        trace.projectTaskTree(project.id);
        trace.snapshot(session.id, 0);
        const started = performance.now();
        const tasks = trace.projectTaskTree(project.id);
        const snapshot = trace.snapshot(session.id, 0);
        const elapsedMs = performance.now() - started;
        expect(tasks).toHaveLength(1_000);
        // Replay is deliberately page-bounded even when the durable cursor contains more events.
        expect(snapshot.events).toHaveLength(500);
        expect(snapshot.cursor).toBe(500);
        expect(elapsedMs).toBeLessThan(1_000);
      }),
    );
  });
});
