import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
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
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
  f.runtime.runPromise(f.workflows.requestNewGoal(f.session, id, next(f.old)));
const settle = (f: Fixture, id = "invoking-run") =>
  f.runtime.runPromise(f.workflows.settleNewGoalRequest(f.session, id));

async function fixture() {
  const context = await testRuntime();
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  const session = context.session.id;
  await context.runtime.runPromise(workflows.setPhase(session, "goal"));
  await context.runtime.runPromise(workflows.updateGoal(session, first));
  await context.runtime.runPromise(
    workflows.updatePlan(session, {
      summary: "first plan",
      steps: [],
      risks: [],
      openQuestions: [],
      status: "ready",
    }),
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
}

test("accepted request leaves identity, state, revision and history untouched until completed settlement; applies once", async () => {
  const f = await fixture();
  const preserved = [
    "workflow_state_revisions",
    "workflow_run_bindings",
    "workflow_run_events",
    "workflow_worker_dispatches",
    "owner_rpc_operations",
  ].map((name) => table(f, name));
  const state = await f.runtime.runPromise(f.workflows.get(f.session));
  expect(await request(f)).toEqual({ status: "accepted", runId: "invoking-run" });
  expect(await request(f)).toEqual({ status: "accepted", runId: "invoking-run" });
  expect(await settle(f)).toEqual({ status: "accepted" });
  expect(identity(f)).toBe(f.old);
  expect(revision(f)).toBe(preserved[0]!.length);
  expect(await f.runtime.runPromise(f.workflows.get(f.session))).toEqual(state);
  expect(table(f, "workflow_new_goal_requests")).toMatchObject([
    { status: "accepted", source_revision_id: revision(f) },
  ]);
  setRun(f, "invoking-run", "completed");
  const applied = await settle(f);
  expect(applied).toMatchObject({ status: "applied" });
  if (applied.status !== "applied") throw new Error("settlement did not apply");
  expect(applied.goalInstanceId).not.toBe(f.old);
  expect(identity(f)).toBe(applied.goalInstanceId);
  expect(await settle(f)).toEqual(applied);
  expect(table(f, "workflow_goal_instances")).toHaveLength(2);
  expect(table(f, "workflow_state_revisions").slice(0, preserved[0]!.length)).toEqual(preserved[0]);
  for (const [index, name] of [
    "workflow_run_bindings",
    "workflow_run_events",
    "workflow_worker_dispatches",
    "owner_rpc_operations",
  ].entries())
    expect(table(f, name)).toEqual(preserved[index + 1]);
  expect(await f.runtime.runPromise(f.workflows.get(f.session))).toMatchObject({
    phase: "goal",
    goal: { statement: "second", version: 1 },
    plan: null,
  });
  const reopened = await f.reopen();
  const reopenedDb = await reopened.runPromise(Database);
  const reopenedWorkflows = await reopened.runPromise(Workflows);
  expect(
    await reopened.runPromise(reopenedWorkflows.settleNewGoalRequest(f.session, "invoking-run")),
  ).toEqual(applied);
  expect(
    reopenedDb.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(f.session),
  ).toEqual({ goal_instance_id: applied.goalInstanceId });
  expect(reopenedDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

for (const status of ["failed", "aborted", "missing", "interrupted"] as const) {
  test(`${status} invoking run never applies accepted new Goal`, async () => {
    const f = await fixture();
    expect(await request(f)).toMatchObject({ status: "accepted" });
    const before = table(f, "workflow_state_revisions");
    if (status === "missing")
      f.db.sqlite.prepare("DELETE FROM chat_runs WHERE run_id = ?").run("invoking-run");
    else setRun(f, "invoking-run", status);
    const result = await settle(f);
    if (status === "interrupted") expect(result).toEqual({ status: "accepted" });
    else expect(result).toEqual({ status: "rejected", reason: "run_outcome_uncertain" });
    expect(await settle(f)).toEqual(result);
    expect(identity(f)).toBe(f.old);
    expect(table(f, "workflow_state_revisions")).toEqual(before);
  });
}

test("stale ID, competing request and active foreign run cannot be admitted", async () => {
  const f = await fixture();
  const before = table(f, "workflow_state_revisions");
  for (const stale of ["stale", null])
    await expect(
      f.runtime.runPromise(
        f.workflows.requestNewGoal(f.session, "invoking-run", {
          ...next(f.old),
          previousGoalInstanceId: stale,
        }),
      ),
    ).rejects.toMatchObject({ reason: "workflow_changed" });
  expect(table(f, "workflow_new_goal_requests")).toEqual([]);
  run(f, "other-run");
  await expect(request(f)).rejects.toMatchObject({ reason: "run_outcome_uncertain" });
  setRun(f, "other-run", "completed");
  expect(await request(f)).toMatchObject({ status: "accepted" });
  await expect(
    f.runtime.runPromise(f.workflows.requestNewGoal(f.session, "other-run", next(f.old))),
  ).rejects.toMatchObject({ reason: "run_outcome_uncertain" });
  run(f, "competing-run");
  await expect(
    f.runtime.runPromise(f.workflows.requestNewGoal(f.session, "competing-run", next(f.old))),
  ).rejects.toMatchObject({ reason: "transition_pending" });
  await expect(
    f.runtime.runPromise(f.workflows.startNewGoal(f.session, next(f.old))),
  ).rejects.toMatchObject({ reason: "transition_pending" });
  expect(table(f, "workflow_new_goal_requests")).toHaveLength(1);
  expect(identity(f)).toBe(f.old);
  expect(table(f, "workflow_state_revisions")).toEqual(before);
});

for (const ownerStatus of ["pending", "uncertain"] as const) {
  test(`${ownerStatus} owner effect blocks settlement without altering old history`, async () => {
    const f = await fixture();
    await request(f);
    f.db.sqlite
      .prepare("UPDATE owner_rpc_operations SET status = ? WHERE run_id = 'historical-run'")
      .run(ownerStatus);
    setRun(f, "invoking-run", "completed");
    const before = table(f, "workflow_state_revisions");
    expect(await settle(f)).toEqual({ status: "rejected", reason: "owner_effect_uncertain" });
    expect(identity(f)).toBe(f.old);
    expect(table(f, "workflow_state_revisions")).toEqual(before);
  });
}

test("revision race rejects accepted request; persisted rejection survives reopen", async () => {
  const f = await fixture();
  await request(f);
  await f.runtime.runPromise(
    f.workflows.updatePlan(f.session, {
      summary: "concurrent revision",
      steps: [],
      risks: [],
      openQuestions: [],
      status: "ready",
    }),
  );
  const before = table(f, "workflow_state_revisions");
  setRun(f, "invoking-run", "completed");
  expect(await settle(f)).toEqual({ status: "rejected", reason: "workflow_changed" });
  expect(identity(f)).toBe(f.old);
  expect(table(f, "workflow_state_revisions")).toEqual(before);
  const reopened = await f.reopen();
  const workflows = await reopened.runPromise(Workflows);
  expect(
    await reopened.runPromise(workflows.settleNewGoalRequest(f.session, "invoking-run")),
  ).toEqual({ status: "rejected", reason: "workflow_changed" });
});

test("restart recovers an unfinished run without silently applying its accepted intent", async () => {
  const f = await fixture();
  await request(f);
  const oldRevisions = table(f, "workflow_state_revisions");
  const reopened = await f.reopen();
  const db = await reopened.runPromise(Database);
  const workflows = await reopened.runPromise(Workflows);
  // Startup resolves orphaned running chat runs; it cannot infer a successful outcome.
  expect(
    db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'invoking-run'").get(),
  ).not.toEqual({ status: "completed" });
  const result = await reopened.runPromise(
    workflows.settleNewGoalRequest(f.session, "invoking-run"),
  );
  expect(result).toMatchObject({ status: "rejected", reason: "run_outcome_uncertain" });
  expect(
    await reopened.runPromise(workflows.settleNewGoalRequest(f.session, "invoking-run")),
  ).toEqual(result);
  expect(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(f.session),
  ).toEqual({ goal_instance_id: f.old });
  expect(db.sqlite.prepare("SELECT * FROM workflow_goal_instances").all()).toHaveLength(1);
  expect(db.sqlite.prepare("SELECT * FROM workflow_state_revisions ORDER BY rowid").all()).toEqual(
    oldRevisions,
  );
});
