import type { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

test.each([
  { status: "pending", sideEffect: true, blocked: true },
  { status: "pending", sideEffect: false, blocked: true },
  { status: "uncertain", sideEffect: true, blocked: true },
  { status: "uncertain", sideEffect: false, blocked: false },
  { status: "succeeded", sideEffect: true, blocked: false },
] as const)(
  "completed run receipt $status sideEffect=$sideEffect fences=$blocked across Goal versions",
  async ({ status, sideEffect, blocked }) => {
    const context = await testRuntime();
    const { db, workflows } = await context.runtime.runPromise(
      Effect.all({ db: Database, workflows: Workflows }),
    );
    await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
    const owner = workflowRunBindings(db);
    const old = owner.bind(context.session.id, "old", latestRevision(db, context.session.id));
    if (old.status !== "bound") throw new Error("expected binding");
    db.sqlite
      .prepare(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', ?)",
      )
      .run("old", context.session.id, Date.now());
    const ledger = makeSqliteOwnerRpcLedger(db);
    const key = JSON.stringify(old.binding);
    expect(ledger.reserve(key, 1, "effect", sideEffect)).toEqual({ type: "reserved" });
    switch (status) {
      case "pending":
        break;
      case "uncertain":
        ledger.settle(key, 1, { type: "uncertain", operationId: 1 });
        break;
      case "succeeded":
        ledger.settle(key, 1, { type: "succeeded", operationId: 1, output: null });
        break;
    }
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, { ...goal, outcomes: ["Revised outcome"] }),
    );
    const receipts = db.sqlite.prepare("SELECT * FROM owner_rpc_operations").all();
    const admitted = owner.bind(context.session.id, "new", latestRevision(db, context.session.id));
    expect(admitted.status).toBe(blocked ? "refused" : "bound");
    if (blocked) expect(admitted).toEqual({ status: "refused", reason: "run_outcome_uncertain" });
    expect(db.sqlite.prepare("SELECT * FROM owner_rpc_operations").all()).toEqual(receipts);
  },
);

const goal = {
  statement: "Preserve an active Goal",
  outcomes: ["Safe evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const latestRevision = (db: { readonly sqlite: DatabaseSync }, sessionId: string) =>
  Number(
    Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
      db.sqlite
        .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
        .get(sessionId),
    ).id,
  );

test("the owner binds a new run to an immutable Goal/Plan revision, not a caller-provided Goal", async () => {
  const context = await testRuntime();
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  const owner = workflowRunBindings(db);
  expect(owner.bind(context.session.id, "legacy", 0)).toEqual({
    status: "refused",
    reason: "legacy_unbound",
  });
  await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
  const revision = latestRevision(db, context.session.id);
  const admitted = owner.bind(context.session.id, "first", revision);
  expect(admitted.status).toBe("bound");
  if (admitted.status !== "bound") throw new Error("expected bound run");
  expect(admitted.binding.goalVersion).toBe(1);
  expect(admitted.binding.planVersion).toBeNull();
  expect(owner.bind(context.session.id, "first", revision)).toEqual({
    status: "refused",
    reason: "run_id_conflict",
  });
  expect(owner.bind(context.session.id, "second", revision)).toEqual({
    status: "refused",
    reason: "run_outcome_uncertain",
  });
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', ?)",
    )
    .run("first", context.session.id, Date.now());
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, { ...goal, outcomes: ["New outcome"] }),
  );
  expect(owner.bind(context.session.id, "second", revision)).toEqual({
    status: "refused",
    reason: "workflow_changed",
  });
  const revised = owner.bind(context.session.id, "second", latestRevision(db, context.session.id));
  expect(revised.status).toBe("bound");
  if (revised.status !== "bound") throw new Error("expected revised run");
  expect(revised.binding.goalInstanceId).toBe(admitted.binding.goalInstanceId);
  expect(revised.binding.goalVersion).toBe(2);
  expect(
    db.sqlite
      .prepare("SELECT goal_version FROM workflow_run_bindings WHERE run_id = 'first'")
      .get(),
  ).toEqual({ goal_version: 1 });
});

test("a run ID and an unresolved side effect cannot be silently adopted by another session", async () => {
  const context = await testRuntime();
  const { db, workflows, sessions } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows, sessions: Sessions }),
  );
  const other = await context.runtime.runPromise(sessions.create(context.project.id));
  await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
  await context.runtime.runPromise(workflows.updateGoal(other.id, goal));
  const identities = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ session_id: Schema.String, goal_instance_id: Schema.String })),
  )(
    db.sqlite
      .prepare(
        "SELECT session_id, goal_instance_id FROM workflow_goal_identities ORDER BY session_id",
      )
      .all(),
  );
  expect(identities).toHaveLength(2);
  expect(identities[0]?.goal_instance_id).not.toBe(identities[1]?.goal_instance_id);
  const owner = workflowRunBindings(db);
  expect(
    owner.bind(context.session.id, "shared", latestRevision(db, context.session.id)).status,
  ).toBe("bound");
  expect(owner.bind(other.id, "shared", latestRevision(db, other.id))).toEqual({
    status: "refused",
    reason: "run_id_conflict",
  });
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'failed', ?)",
    )
    .run("shared", context.session.id, Date.now());
  expect(
    owner.bind(context.session.id, "different", latestRevision(db, context.session.id)),
  ).toEqual({
    status: "refused",
    reason: "run_outcome_uncertain",
  });
  expect(() =>
    db.sqlite
      .prepare("UPDATE workflow_run_bindings SET goal_version = 3 WHERE run_id = 'shared'")
      .run(),
  ).toThrow("run binding is immutable");
});

test("the schema rejects a binding assembled from another session's Goal and revision", async () => {
  const context = await testRuntime();
  const { db, workflows, sessions } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows, sessions: Sessions }),
  );
  const other = await context.runtime.runPromise(sessions.create(context.project.id));
  await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal));
  await context.runtime.runPromise(workflows.updateGoal(other.id, goal));
  const identity = Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(context.session.id),
  );
  const revision = latestRevision(db, context.session.id);
  expect(() =>
    db.sqlite
      .prepare(`
        INSERT INTO workflow_run_bindings
          (run_id, session_id, goal_instance_id, goal_version, plan_version, workflow_revision_id, created_at)
        VALUES (?, ?, ?, 1, NULL, ?, ?)
      `)
      .run("forged", other.id, identity.goal_instance_id, revision, new Date().toISOString()),
  ).toThrow("run binding session mismatch");
});
