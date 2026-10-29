import { DatabaseSync } from "node:sqlite";
import { Clock, Duration, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { migrateDatabase } from "../src/db/database.ts";
import { WorkflowExecution } from "../src/workflow/execution.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testAgent } from "./support/test-env.ts";
import { sqlAll, sqlGet } from "./support/sql.ts";

const fixture = new URL("./fixtures/release-0.0.17.sql", import.meta.url);

/** Sessions the fixture made at 0.0.17; its header says how. */
const sessions = {
  /** Running run with an accepted new-Goal request, a pending approval and a provider retry. */
  waiting: "5b3d4c6f-953d-4654-a2f2-2cbfbee89c25",
  /** Interrupted run with an accepted new-Goal request. */
  interrupted: "9983e6ce-47c3-4f53-ad7f-9a6a172d9470",
  /** Goal and Plan completed while the phase stayed `execute`. */
  goalCompleted: "4c0244eb-ffed-4073-98a2-8f5c55d41bb9",
  /** Plan completed while the Goal stayed active. */
  planCompleted: "fea8e2f8-9f91-4381-835f-d1f2308b3445",
} as const;
const invoking = (session: string) => `${session}:invoking`;

const connection = (file: string, defensive: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(file, { defensive })),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );

/**
 * Loads the fixture as the agent's database and migrates it. The upgrade happens right after the
 * fixture was written: the approval timeout keeps its distance from that moment, and the provider
 * retry is due now so the restarted agent fires it.
 */
const seed = Effect.fnUntraced(function* (storage: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(storage, "agent.db");
  const dump = yield* fs.readFileString(yield* path.fromFileUrl(fixture));
  yield* fs.makeDirectory(storage, { recursive: true });
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.scoped(
    Effect.map(connection(file, false), (sqlite) => {
      sqlite.exec(dump);
      sqlite
        .prepare(
          `UPDATE owner_workflow_clocks SET due_at = due_at + ? - (SELECT max(started_at) FROM chat_runs)
            WHERE workflow_name = 'RelayedApprovalExecution'`,
        )
        .run(now);
      sqlite
        .prepare(
          "UPDATE owner_workflow_clocks SET due_at = ? WHERE workflow_name = 'ProviderRetryWait'",
        )
        .run(now);
    }),
  );
  // The FTS5 tables the dump restores through writable_schema exist only for a new connection.
  const [elapsed] = yield* Effect.scoped(
    Effect.flatMap(connection(file, true), (sqlite) => Effect.timed(migrateDatabase(sqlite))),
  );
  yield* Effect.logInfo(`0.0.17 fixture migrated in ${Duration.toMillis(elapsed)} ms`);
  expect(Duration.toMillis(elapsed)).toBeLessThan(2_000);
}, Effect.orDie);

const completes = (workflowName: string) =>
  Effect.flatMap(
    sqlGet("SELECT status FROM owner_workflow_executions WHERE workflow_name = ?", workflowName),
    Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String })),
  ).pipe(
    Effect.filterOrFail(
      (row) => row.status === "completed",
      (row) => row.status,
    ),
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeout("5 seconds"),
  );

testAgent({ beforeOpen: seed })("upgrade from 0.0.17", (it) => {
  it.effect("keeps the pending approval and the provider retry wait", () =>
    Effect.gen(function* () {
      const relayed = yield* RelayedApprovals;
      const pending = yield* relayed.pending(sessions.waiting);
      expect(pending.map((approval) => approval.toolName)).toEqual(["write_file"]);
      yield* completes("ProviderRetryWait");
      expect(yield* relayed.answer(sessions.waiting, pending[0]?.id ?? "", true)).toBe(true);
      yield* completes("RelayedApprovalExecution");
    }),
  );

  it.effect("ends the runs the restart cut off", () =>
    Effect.gen(function* () {
      expect(
        yield* sqlAll(
          "SELECT run_id, status, error_code FROM chat_runs WHERE run_id IN (?, ?) ORDER BY run_id",
          invoking(sessions.waiting),
          invoking(sessions.interrupted),
        ),
      ).toEqual(
        [sessions.waiting, sessions.interrupted].map((session) => ({
          run_id: invoking(session),
          status: "failed",
          error_code: "server_restarted",
        })),
      );
    }),
  );

  it.effect("leaves the creation time of 0.0.17 executions unknown", () =>
    Effect.gen(function* () {
      expect(yield* sqlAll("SELECT created_at FROM owner_workflow_executions")).toEqual([
        { created_at: null },
        { created_at: null },
      ]);
    }),
  );

  // Step 7: the startup check settles requests whose run the restart ended.
  it.effect.fails("rejects new-Goal requests whose run outcome the restart lost", () =>
    Effect.gen(function* () {
      expect(
        yield* sqlAll(
          "SELECT run_id, status, reason FROM workflow_new_goal_requests ORDER BY run_id",
        ),
      ).toEqual(
        [sessions.waiting, sessions.interrupted].map((session) => ({
          run_id: invoking(session),
          status: "rejected",
          reason: "run_outcome_uncertain",
        })),
      );
    }),
  );

  // Step 7: the startup check repairs R1 and R2 and stops their automatic runs.
  it.effect.fails("repairs the sessions 0.0.17 left unable to finish", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const execution = yield* WorkflowExecution;
      const completed = yield* workflows.get(sessions.goalCompleted);
      const verifying = yield* workflows.get(sessions.planCompleted);
      expect([completed.phase, completed.goal?.status]).toEqual(["completed", "completed"]);
      expect([verifying.phase, verifying.goal?.status, verifying.plan?.status]).toEqual([
        "verify",
        "active",
        "executing",
      ]);
      expect(
        yield* Effect.forEach([sessions.goalCompleted, sessions.planCompleted], execution.get),
      ).toEqual(Array.from({ length: 2 }, () => ({ _tag: "stopped", reason: "state_reconciled" })));
    }),
  );
});
