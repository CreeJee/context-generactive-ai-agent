import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { WorkflowTools } from "../src/workflow/tools.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "first",
  outcomes: ["first success"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const plan = {
  summary: "method",
  steps: [],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};
const identity = (db: Database["Service"], session: string) =>
  String(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(session)?.goal_instance_id,
  );
const rows = (db: Database["Service"], table: string) =>
  db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const transition = (previousGoalInstanceId: string | null) => ({
  action: "new_independent_goal" as const,
  previousGoalInstanceId,
  reason: "explicit independent task",
  goal: { ...goal, statement: "second", outcomes: ["different success"] },
});

async function fixture() {
  const context = await testRuntime();
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  const session = context.session.id;
  await context.runtime.runPromise(workflows.setPhase(session, "goal"));
  await context.runtime.runPromise(workflows.updateGoal(session, goal));
  await context.runtime.runPromise(workflows.updatePlan(session, plan));
  const old = identity(db, session);
  const revision = Number(
    db.sqlite
      .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
      .get(session)?.id,
  );
  expect(workflowRunBindings(db).bind(session, "old-run", revision).status).toBe("bound");
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES ('old-run', ?, 'completed', 1)",
    )
    .run(session);
  db.sqlite.exec(`
    INSERT INTO workflow_run_events (run_id, event_key, kind, payload_json, created_at) VALUES ('old-run', 'done', 'run_completed', '{"bytes":"old\\r\\n"}', 'old');
    INSERT INTO workflow_worker_dispatches VALUES ('old-run', 'old-generation', 'old');
    INSERT INTO owner_rpc_operations VALUES ('old-run', 'key', 1, 'fingerprint', 1, '{"status":"old"}', 'succeeded');
  `);
  return { ...context, db, workflows, sessionId: session, old };
}

test("explicit new identity preserves prior revisions, bindings, receipts and evidence through reopen", async () => {
  const f = await fixture();
  await f.runtime.runPromise(
    f.workflows.updateProgress(f.sessionId, {
      goalStatus: "completed",
      goalEvidence: ["old proof"],
      planEvidence: [],
      steps: [],
      verification: { status: "passed", summary: "old success", evidence: ["old proof"] },
      detail: "verified first",
    }),
  );
  await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "verify"));
  const tables = [
    "workflow_state_revisions",
    "workflow_run_bindings",
    "workflow_run_events",
    "workflow_worker_dispatches",
    "owner_rpc_operations",
  ];
  const before = tables.map((table) => rows(f.db, table));
  const next = await f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old)));
  const newId = identity(f.db, f.sessionId);
  expect(newId).not.toBe(f.old);
  expect(next.goal).toMatchObject({
    version: 1,
    evidence: [],
    verification: { status: "not_run", evidence: [] },
  });
  expect(next.phase).toBe("goal");
  expect(next.plan).toBeNull();
  for (const [index, table] of tables.entries()) {
    const actual = rows(f.db, table);
    expect(
      table === "workflow_state_revisions" ? actual.slice(0, before[index]?.length) : actual,
    ).toEqual(before[index]);
  }
  expect(rows(f.db, "workflow_goal_instances")).toHaveLength(2);
  await f.runtime.runPromise(f.workflows.updatePlan(f.sessionId, plan));
  expect(identity(f.db, f.sessionId)).toBe(newId);
  expect((await f.runtime.runPromise(f.workflows.get(f.sessionId))).goal?.version).toBe(1);
  await f.runtime.runPromise(
    f.workflows.updateGoal(f.sessionId, { ...goal, outcomes: ["revised second purpose"] }),
  );
  expect(identity(f.db, f.sessionId)).toBe(newId);
  expect((await f.runtime.runPromise(f.workflows.get(f.sessionId))).goal?.version).toBe(2);
  const reopened = await f.reopen();
  const reopenedDb = await reopened.runPromise(Database);
  expect(identity(reopenedDb, f.sessionId)).toBe(newId);
  expect(
    reopenedDb.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_run_bindings WHERE run_id = 'old-run'")
      .get(),
  ).toEqual({ goal_instance_id: f.old });
  expect(
    reopenedDb.sqlite
      .prepare(
        "SELECT state_json FROM workflow_state_revisions WHERE goal_instance_id = ? ORDER BY id",
      )
      .all(f.old),
  ).toHaveLength(before[0]!.length - 1);
  expect(
    reopenedDb.sqlite
      .prepare(
        "SELECT state_json FROM workflow_state_revisions WHERE goal_instance_id = ? ORDER BY id",
      )
      .all(newId),
  ).toHaveLength(3);
  expect(reopenedDb.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // Compatible code rollback only disables the new action, retaining pointer and history.
  const disabled = Workflows.layerWithOptions({ allowNewGoal: false }).pipe(
    Layer.provide(Layer.succeed(Database, reopenedDb)),
  );
  await expect(
    Effect.runPromise(
      Effect.flatMap(Workflows, (w) => w.startNewGoal(f.sessionId, transition(newId))).pipe(
        Effect.provide(disabled),
      ),
    ),
  ).rejects.toMatchObject({ reason: "disabled" });
  expect(rows(reopenedDb, "workflow_goal_instances")).toHaveLength(2);
});

for (const status of ["running", "failed", "missing"] as const) {
  test(`new Goal cannot overwrite ${status} bound worker execution`, async () => {
    const f = await fixture();
    if (status === "missing") f.db.sqlite.exec("DELETE FROM chat_runs WHERE run_id = 'old-run'");
    else
      f.db.sqlite.prepare("UPDATE chat_runs SET status = ? WHERE run_id = 'old-run'").run(status);
    const before = rows(f.db, "workflow_state_revisions");
    await expect(
      f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
    ).rejects.toMatchObject({ reason: "run_outcome_uncertain" });
    expect(identity(f.db, f.sessionId)).toBe(f.old);
    expect(rows(f.db, "workflow_state_revisions")).toEqual(before);
  });
}
for (const status of ["pending", "uncertain"] as const) {
  test(`completed run with ${status} owner effect still denies transition`, async () => {
    const f = await fixture();
    f.db.sqlite
      .prepare("UPDATE owner_rpc_operations SET status = ? WHERE run_id = 'old-run'")
      .run(status);
    await expect(
      f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
    ).rejects.toMatchObject({ reason: "owner_effect_uncertain" });
    expect(identity(f.db, f.sessionId)).toBe(f.old);
  });
}

test("owner tool is exposed at potential source phases and checks latest state", async () => {
  const f = await fixture();
  const tools = await f.runtime.runPromise(WorkflowTools);
  for (const phase of ["chat", "execute"] as const)
    expect(
      tools.forSession(f.sessionId, phase).some((tool) => tool.name === "start_new_goal"),
    ).toBe(false);
  for (const phase of ["goal", "plan", "verify", "completed"] as const)
    expect(
      tools.forSession(f.sessionId, phase).some((tool) => tool.name === "start_new_goal"),
    ).toBe(true);
  const action = tools
    .forSession(f.sessionId, "goal")
    .find((tool) => tool.name === "start_new_goal");
  if (!action?.execute) throw new Error("owner action missing");
  await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "execute"));
  expect(await action.execute(transition(f.old))).toMatchObject({
    error: "new_goal_transition_refused",
    reason: "phase_not_authorized",
  });
  await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "plan"));
  expect(await action.execute(transition(f.old))).toMatchObject({
    goal: { version: 1 },
    plan: null,
  });
});

test("correct Goal ID still refuses direct transition while the calling run is active", async () => {
  const f = await fixture();
  const tools = await f.runtime.runPromise(WorkflowTools);
  const action = tools
    .forSession(f.sessionId, "goal")
    .find((tool) => tool.name === "start_new_goal");
  if (!action?.execute) throw new Error("owner action missing");
  f.db.sqlite.exec("UPDATE chat_runs SET status = 'running' WHERE run_id = 'old-run'");
  const before = rows(f.db, "workflow_state_revisions");
  expect(await action.execute(transition(f.old))).toMatchObject({
    error: "new_goal_transition_refused",
    reason: "run_outcome_uncertain",
  });
  expect(identity(f.db, f.sessionId)).toBe(f.old);
  expect(rows(f.db, "workflow_state_revisions")).toEqual(before);
});

test("legacy historical Goal and revisions remain unbound after explicit new Goal", async () => {
  const f = await testRuntime();
  const { db, workflows } = await f.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  await f.runtime.runPromise(workflows.setPhase(f.session.id, "goal"));
  // Represent a real legacy artifact directly, without assigning any historical ID.
  db.sqlite.prepare("UPDATE session_workflows SET state_json = ? WHERE session_id = ?").run(
    JSON.stringify({
      phase: "goal",
      goal: {
        ...goal,
        version: 4,
        evidence: ["legacy"],
        verification: {
          status: "passed",
          summary: "old",
          evidence: ["legacy"],
          recoveryPhase: null,
          updatedAt: null,
        },
        updatedAt: "old",
      },
      plan: null,
      ledger: [],
    }),
    f.session.id,
  );
  const before = rows(db, "workflow_state_revisions");
  expect(
    await f.runtime.runPromise(workflows.startNewGoal(f.session.id, transition(null))),
  ).toMatchObject({ goal: { version: 1, evidence: [] } });
  expect(rows(db, "workflow_state_revisions").slice(0, before.length)).toEqual(before);
  expect(rows(db, "workflow_goal_instances")).toHaveLength(1);
});

test("Verify must be closed and active invoking run never receives an exemption", async () => {
  const f = await fixture();
  await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "verify"));
  await expect(
    f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
  ).rejects.toMatchObject({ reason: "phase_not_authorized" });
  await f.runtime.runPromise(
    f.workflows.updateProgress(f.sessionId, {
      goalStatus: "completed",
      goalEvidence: ["old proof"],
      planEvidence: [],
      steps: [],
      verification: { status: "passed", summary: "closed", evidence: ["old proof"] },
      detail: "closed old task",
    }),
  );
  f.db.sqlite.exec("UPDATE chat_runs SET status = 'running' WHERE run_id = 'old-run'");
  const before = rows(f.db, "workflow_state_revisions");
  await expect(
    f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
  ).rejects.toMatchObject({ reason: "run_outcome_uncertain" });
  expect(identity(f.db, f.sessionId)).toBe(f.old);
  expect(rows(f.db, "workflow_state_revisions")).toEqual(before);
});

for (const scenario of [
  { name: "goal with an existing Goal", phase: "goal", closed: false, allowed: true },
  { name: "plan with an existing Goal", phase: "plan", closed: false, allowed: true },
  { name: "closed verify", phase: "verify", closed: true, allowed: true },
  { name: "completed workflow", phase: "completed", closed: true, allowed: true },
  { name: "unclosed verify", phase: "verify", closed: false, allowed: false },
  { name: "execute", phase: "execute", closed: false, allowed: false },
  { name: "chat", phase: "chat", closed: false, allowed: false },
] as const) {
  test(`transition source: ${scenario.name}`, async () => {
    const f = await fixture();
    if (scenario.closed) {
      await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "verify"));
      await f.runtime.runPromise(
        f.workflows.updateProgress(f.sessionId, {
          goalStatus: "completed",
          goalEvidence: ["verified"],
          planEvidence: [],
          steps: [],
          verification: { status: "passed", summary: "verified", evidence: ["verified"] },
          detail: "closed workflow",
        }),
      );
      if (scenario.phase === "completed")
        await f.runtime.runPromise(f.workflows.finishRun(f.sessionId, "verify"));
    } else if (scenario.phase !== "goal") {
      await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, scenario.phase));
    }
    expect((await f.runtime.runPromise(f.workflows.get(f.sessionId))).phase).toBe(scenario.phase);
    const before = rows(f.db, "workflow_state_revisions");
    if (scenario.allowed) {
      expect(
        await f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
      ).toMatchObject({ goal: { version: 1 }, plan: null });
      expect(identity(f.db, f.sessionId)).not.toBe(f.old);
    } else {
      await expect(
        f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
      ).rejects.toMatchObject({ reason: "phase_not_authorized" });
      expect(identity(f.db, f.sessionId)).toBe(f.old);
      expect(rows(f.db, "workflow_state_revisions")).toEqual(before);
    }
  });
}

test("stale identity and execution phase cannot authorize new Goal", async () => {
  const f = await fixture();
  const before = rows(f.db, "workflow_state_revisions");
  for (const stale of ["wrong", null]) {
    await expect(
      f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(stale))),
    ).rejects.toMatchObject({ reason: "workflow_changed" });
    expect(identity(f.db, f.sessionId)).toBe(f.old);
    expect(rows(f.db, "workflow_state_revisions")).toEqual(before);
  }
  await f.runtime.runPromise(f.workflows.setPhase(f.sessionId, "execute"));
  await expect(
    f.runtime.runPromise(f.workflows.startNewGoal(f.sessionId, transition(f.old))),
  ).rejects.toMatchObject({ reason: "phase_not_authorized" });
});
