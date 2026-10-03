import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { makeGoalWorkerGenerationStore } from "../src/agent/goal-worker-generation-store.ts";
import { goalWorkerAuthority } from "../src/agent/goal-worker-authority.ts";
import { Database } from "../src/db/database.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goalId = (db: typeof Database.Service, sessionId: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(sessionId),
  ).goal_instance_id;
const goal = (statement: string) => ({
  statement,
  outcomes: ["Keep generation evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
});
const setup = async () => {
  const context = await testRuntime();
  const { db, workflows } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows }),
  );
  await context.runtime.runPromise(workflows.updateGoal(context.session.id, goal("Original Goal")));
  return { context, db, workflows };
};
const pin = (goalInstanceId: string) => ({
  goalInstanceId,
  sourceGeneration: "source-v1",
  manifestHash: "a".repeat(64),
  workerUrl: "file:///test-only/source-v1/full-loop-worker.ts",
});

test("source generation persists across Goal amendments and owner reopen, independently of run tokens", async () => {
  const { context, db, workflows } = await setup();
  const id = goalId(db, context.session.id);
  const store = makeGoalWorkerGenerationStore(db);
  expect(store.record(pin(id))).toEqual(pin(id));
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, goal("Amended outcome, same Goal")),
  );
  expect(goalId(db, context.session.id)).toBe(id);
  expect(store.get(id)).toEqual(pin(id));
  const reopened = await context.reopen();
  const restored = await reopened.runPromise(Database);
  expect(makeGoalWorkerGenerationStore(restored).get(id)).toEqual(pin(id));
  expect(
    restored.sqlite.prepare("SELECT count(*) AS n FROM workflow_worker_dispatches").get(),
  ).toEqual({ n: 0 });
});

test("a source pin is immutable and replacement cannot erase its evidence", async () => {
  const { context, db } = await setup();
  const id = goalId(db, context.session.id);
  const store = makeGoalWorkerGenerationStore(db);
  store.record(pin(id));
  expect(() => store.record({ ...pin(id), sourceGeneration: "replacement" })).toThrow(
    /already pinned/,
  );
  expect(() =>
    db.sqlite
      .prepare("UPDATE workflow_goal_worker_generations SET source_generation = 'replacement'")
      .run(),
  ).toThrow(/immutable/);
  expect(() => db.sqlite.prepare("DELETE FROM workflow_goal_worker_generations").run()).toThrow(
    /immutable/,
  );
  expect(store.get(id)).toEqual(pin(id));
});

test("historical unpinned dispatch stays unbound instead of silently acquiring current code", async () => {
  const { context, db } = await setup();
  const revision = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  const reserved = workflowRunBindings(db).bind(context.session.id, "old-unpinned", revision.id);
  expect(reserved.status).toBe("bound");
  if (reserved.status !== "bound") throw new Error("Expected a fresh binding");
  expect(goalWorkerAuthority(db).issue(reserved.binding, "old-run-generation")).not.toBeNull();
  const id = goalId(db, context.session.id);
  const store = makeGoalWorkerGenerationStore(db);
  expect(store.hasUnpinnedDispatch(id)).toBe(true);
  expect(() => store.record(pin(id))).toThrow(/no recoverable source pin/);
  expect(store.get(id)).toBeUndefined();
  expect(
    db.sqlite
      .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = 'old-unpinned'")
      .get(),
  ).toEqual({ generation: "old-run-generation" });
});
