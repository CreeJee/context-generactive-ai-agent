import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { testRuntime } from "./support/runtime.ts";

const first = {
  statement: "first",
  outcomes: ["first proof"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const next = (id: string) => ({
  action: "new_independent_goal" as const,
  previousGoalInstanceId: id,
  reason: "independent next task",
  goal: { ...first, statement: "second", outcomes: ["second proof"] },
});
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const table = (f: Fixture, name: string) =>
  f.db.sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const identity = (f: Fixture) =>
  String(
    f.db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(f.session)?.goal_instance_id,
  );
const revision = (f: Fixture) =>
  Number(
    f.db.sqlite
      .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
      .get(f.session)?.id,
  );
const run = (f: Pick<Fixture, "db" | "session">, id: string, status = "running") => {
  f.db.sqlite
    .prepare("INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, 1)")
    .run(id, f.session, status);
};
const setRun = (f: Fixture, id: string, status: string) =>
  f.db.sqlite.prepare("UPDATE chat_runs SET status = ? WHERE run_id = ?").run(status, id);
const request = (f: Fixture, id = "invoking-run") =>
  f.workflows.requestNewGoal(f.session, id, next(f.old));
const settle = (f: Fixture, id = "invoking-run") => f.workflows.settleNewGoalRequest(f.session, id);

const fixture = Effect.fnUntraced(function* () {
  const context = yield* Effect.promise(() => testRuntime());
  const { db, workflows } = yield* Effect.provideContext(
    Effect.all({ db: Database, workflows: Workflows }),
    yield* context.runtime.contextEffect,
  );
  const session = context.session.id;
  yield* Effect.provideContext(
    workflows.setPhase(session, "goal"),
    yield* context.runtime.contextEffect,
  );
  yield* Effect.provideContext(
    workflows.updateGoal(session, first),
    yield* context.runtime.contextEffect,
  );
  yield* Effect.provideContext(
    workflows.updatePlan(session, {
      summary: "first plan",
      steps: [],
      risks: [],
      openQuestions: [],
      status: "ready",
    }),
    yield* context.runtime.contextEffect,
  );
  const old = String(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(session)?.goal_instance_id,
  );
  const oldRevision = Number(
    db.sqlite
      .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
      .get(session)?.id,
  );
  expect(workflowRunBindings(db).bind(session, "historical-run", oldRevision).status).toBe("bound");
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('historical-run', ?, 'completed', 1)",
    )
    .run(session);
  db.sqlite.exec(`
    INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at)
      VALUES ('historical-run', 'done', 'run_completed', '{"old":true}', 'old');
    INSERT INTO workflow_worker_dispatches VALUES ('historical-run', 'old-generation', 'old');
    INSERT INTO owner_rpc_operations VALUES
      ('historical-run', 'old-key', 1, 'fingerprint', 1, '{"old":true}', 'succeeded');
  `);
  expect(workflowRunBindings(db).bind(session, "invoking-run", oldRevision).status).toBe("bound");
  run({ db, session }, "invoking-run");
  return { ...context, db, workflows, session, old };
});

it.live(
  "accepted request leaves identity, state, revision and history untouched until completed settlement; applies once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const preserved = [
        "workflow_state_revisions",
        "workflow_run_bindings",
        "workflow_run_events",
        "workflow_worker_dispatches",
        "owner_rpc_operations",
      ].map((name) => table(f, name));
      const state = yield* Effect.provideContext(
        f.workflows.get(f.session),
        yield* f.runtime.contextEffect,
      );
      expect(yield* request(f)).toEqual({ status: "accepted", runId: "invoking-run" });
      expect(yield* request(f)).toEqual({ status: "accepted", runId: "invoking-run" });
      expect(yield* settle(f)).toEqual({ status: "accepted" });
      expect(identity(f)).toBe(f.old);
      expect(revision(f)).toBe(preserved[0]!.length);
      expect(
        yield* Effect.provideContext(f.workflows.get(f.session), yield* f.runtime.contextEffect),
      ).toEqual(state);
      expect(table(f, "workflow_new_goal_requests")).toMatchObject([
        { status: "accepted", source_revision_id: revision(f) },
      ]);
      setRun(f, "invoking-run", "completed");
      const applied = yield* settle(f);
      expect(applied).toMatchObject({ status: "applied" });
      if (applied.status !== "applied") throw new Error("settlement did not apply");
      expect(applied.goalInstanceId).not.toBe(f.old);
      expect(identity(f)).toBe(applied.goalInstanceId);
      expect(yield* settle(f)).toEqual(applied);
      expect(table(f, "workflow_goal_instances")).toHaveLength(2);
      expect(table(f, "workflow_state_revisions").slice(0, preserved[0]!.length)).toEqual(
        preserved[0],
      );
      for (const [index, name] of [
        "workflow_run_bindings",
        "workflow_run_events",
        "workflow_worker_dispatches",
        "owner_rpc_operations",
      ].entries())
        expect(table(f, name)).toEqual(preserved[index + 1]);
      expect(
        yield* Effect.provideContext(f.workflows.get(f.session), yield* f.runtime.contextEffect),
      ).toMatchObject({
        phase: "goal",
        goal: { statement: "second", version: 1 },
        plan: null,
      });
      const reopened = yield* Effect.promise(() => f.reopen());
      const reopenedDb = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
      const reopenedWorkflows = yield* Effect.provideContext(
        Workflows,
        yield* reopened.contextEffect,
      );
      expect(
        yield* Effect.provideContext(
          reopenedWorkflows.settleNewGoalRequest(f.session, "invoking-run"),
          yield* reopened.contextEffect,
        ),
      ).toEqual(applied);
      expect(
        reopenedDb.sqlite
          .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
          .get(f.session),
      ).toEqual({ goal_instance_id: applied.goalInstanceId });
      expect(reopenedDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }),
);

for (const status of ["failed", "aborted", "missing", "interrupted"] as const) {
  it.live(`${status} invoking run never applies accepted new Goal`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* request(f)).toMatchObject({ status: "accepted" });
      const before = table(f, "workflow_state_revisions");
      if (status === "missing")
        f.db.sqlite.prepare("DELETE FROM chat_runs WHERE run_id = ?").run("invoking-run");
      else setRun(f, "invoking-run", status);
      const result = yield* settle(f);
      if (status === "interrupted") expect(result).toEqual({ status: "accepted" });
      else expect(result).toEqual({ status: "rejected", reason: "run_outcome_uncertain" });
      expect(yield* settle(f)).toEqual(result);
      expect(identity(f)).toBe(f.old);
      expect(table(f, "workflow_state_revisions")).toEqual(before);
    }),
  );
}

it.live("stale ID, competing request and active foreign run cannot be admitted", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = table(f, "workflow_state_revisions");
    for (const stale of ["stale", null])
      expect(
        yield* Effect.flip(
          Effect.provideContext(
            f.workflows.requestNewGoal(f.session, "invoking-run", {
              ...next(f.old),
              previousGoalInstanceId: stale,
            }),
            yield* f.runtime.contextEffect,
          ),
        ),
      ).toMatchObject({ reason: "workflow_changed" });
    expect(table(f, "workflow_new_goal_requests")).toEqual([]);
    run(f, "other-run");
    expect(yield* Effect.flip(request(f))).toMatchObject({ reason: "run_outcome_uncertain" });
    setRun(f, "other-run", "completed");
    expect(yield* request(f)).toMatchObject({ status: "accepted" });
    expect(
      yield* Effect.flip(
        Effect.provideContext(
          f.workflows.requestNewGoal(f.session, "other-run", next(f.old)),
          yield* f.runtime.contextEffect,
        ),
      ),
    ).toMatchObject({ reason: "run_outcome_uncertain" });
    run(f, "competing-run");
    expect(
      yield* Effect.flip(
        Effect.provideContext(
          f.workflows.requestNewGoal(f.session, "competing-run", next(f.old)),
          yield* f.runtime.contextEffect,
        ),
      ),
    ).toMatchObject({ reason: "transition_pending" });
    expect(
      yield* Effect.flip(
        Effect.provideContext(
          f.workflows.startNewGoal(f.session, next(f.old)),
          yield* f.runtime.contextEffect,
        ),
      ),
    ).toMatchObject({ reason: "transition_pending" });
    expect(table(f, "workflow_new_goal_requests")).toHaveLength(1);
    expect(identity(f)).toBe(f.old);
    expect(table(f, "workflow_state_revisions")).toEqual(before);
  }),
);

for (const ownerStatus of ["pending", "uncertain"] as const) {
  it.live(`${ownerStatus} owner effect blocks settlement without altering old history`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* request(f);
      f.db.sqlite
        .prepare("UPDATE owner_rpc_operations SET status = ? WHERE run_id = 'historical-run'")
        .run(ownerStatus);
      setRun(f, "invoking-run", "completed");
      const before = table(f, "workflow_state_revisions");
      expect(yield* settle(f)).toEqual({ status: "rejected", reason: "owner_effect_uncertain" });
      expect(identity(f)).toBe(f.old);
      expect(table(f, "workflow_state_revisions")).toEqual(before);
    }),
  );
}

it.live("revision race rejects accepted request; persisted rejection survives reopen", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* request(f);
    yield* Effect.provideContext(
      f.workflows.updatePlan(f.session, {
        summary: "concurrent revision",
        steps: [],
        risks: [],
        openQuestions: [],
        status: "ready",
      }),
      yield* f.runtime.contextEffect,
    );
    const before = table(f, "workflow_state_revisions");
    setRun(f, "invoking-run", "completed");
    expect(yield* settle(f)).toEqual({ status: "rejected", reason: "workflow_changed" });
    expect(identity(f)).toBe(f.old);
    expect(table(f, "workflow_state_revisions")).toEqual(before);
    const reopened = yield* Effect.promise(() => f.reopen());
    const workflows = yield* Effect.provideContext(Workflows, yield* reopened.contextEffect);
    expect(
      yield* Effect.provideContext(
        workflows.settleNewGoalRequest(f.session, "invoking-run"),
        yield* reopened.contextEffect,
      ),
    ).toEqual({ status: "rejected", reason: "workflow_changed" });
  }),
);

it.live("restart recovers an unfinished run without silently applying its accepted intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* request(f);
    const oldRevisions = table(f, "workflow_state_revisions");
    const reopened = yield* Effect.promise(() => f.reopen());
    const db = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
    const workflows = yield* Effect.provideContext(Workflows, yield* reopened.contextEffect);
    // Startup resolves orphaned running chat runs; it cannot infer a successful outcome.
    expect(
      db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'invoking-run'").get(),
    ).not.toEqual({ status: "completed" });
    const result = yield* Effect.provideContext(
      workflows.settleNewGoalRequest(f.session, "invoking-run"),
      yield* reopened.contextEffect,
    );
    expect(result).toMatchObject({ status: "rejected", reason: "run_outcome_uncertain" });
    expect(
      yield* Effect.provideContext(
        workflows.settleNewGoalRequest(f.session, "invoking-run"),
        yield* reopened.contextEffect,
      ),
    ).toEqual(result);
    expect(
      db.sqlite
        .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
        .get(f.session),
    ).toEqual({ goal_instance_id: f.old });
    expect(db.sqlite.prepare("SELECT * FROM workflow_goal_instances").all()).toHaveLength(1);
    expect(
      db.sqlite.prepare("SELECT * FROM workflow_state_revisions ORDER BY rowid").all(),
    ).toEqual(oldRevisions);
  }),
);
