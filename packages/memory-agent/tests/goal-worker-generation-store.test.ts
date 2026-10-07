import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeGoalWorkerGenerationStore } from "../src/agent/goal-worker-generation-store.ts";
import { goalWorkerAuthority } from "../src/agent/goal-worker-authority.ts";
import { Database } from "../src/db/database.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goalId = (db: typeof Database.Service, sessionId: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(sessionId),
  ).pipe(Effect.map((row) => row.goal_instance_id));
const goal = (statement: string) => ({
  statement,
  outcomes: ["Keep generation evidence"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
});
const setup = Effect.fnUntraced(function* () {
  const context = yield* Effect.promise(() => testRuntime());
  const { db, workflows } = yield* Effect.provideContext(
    Effect.all({ db: Database, workflows: Workflows }),
    yield* context.runtime.contextEffect,
  );
  yield* Effect.provideContext(
    workflows.updateGoal(context.session.id, goal("Original Goal")),
    yield* context.runtime.contextEffect,
  );
  return { context, db, workflows };
});
const pin = (goalInstanceId: string) => ({
  goalInstanceId,
  sourceGeneration: "source-v1",
  manifestHash: "a".repeat(64),
  workerUrl: "file:///test-only/source-v1/full-loop-worker.ts",
});

it.live(
  "source generation persists across Goal amendments and owner reopen, independently of run tokens",
  () =>
    Effect.gen(function* () {
      const { context, db, workflows } = yield* setup();
      const id = yield* goalId(db, context.session.id);
      const store = makeGoalWorkerGenerationStore(db);
      expect(store.record(pin(id))).toEqual(pin(id));
      yield* Effect.provideContext(
        workflows.updateGoal(context.session.id, goal("Amended outcome, same Goal")),
        yield* context.runtime.contextEffect,
      );
      expect(yield* goalId(db, context.session.id)).toBe(id);
      expect(store.get(id)).toEqual(pin(id));
      const reopened = yield* Effect.promise(() => context.reopen());
      const restored = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
      expect(makeGoalWorkerGenerationStore(restored).get(id)).toEqual(pin(id));
      expect(
        restored.sqlite.prepare("SELECT count(*) AS n FROM workflow_worker_dispatches").get(),
      ).toEqual({ n: 0 });
    }),
);

it.live("a source pin is immutable and replacement cannot erase its evidence", () =>
  Effect.gen(function* () {
    const { context, db } = yield* setup();
    const id = yield* goalId(db, context.session.id);
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
  }),
);

it.live(
  "historical unpinned dispatch stays unbound instead of silently acquiring current code",
  () =>
    Effect.gen(function* () {
      const { context, db } = yield* setup();
      const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
        db.sqlite
          .prepare(
            "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(context.session.id),
      );
      const reserved = workflowRunBindings(db).bind(
        context.session.id,
        "old-unpinned",
        revision.id,
      );
      expect(reserved.status).toBe("bound");
      if (reserved.status !== "bound") throw new Error("Expected a fresh binding");
      expect(goalWorkerAuthority(db).issue(reserved.binding, "old-run-generation")).not.toBeNull();
      const id = yield* goalId(db, context.session.id);
      const store = makeGoalWorkerGenerationStore(db);
      expect(store.hasUnpinnedDispatch(id)).toBe(true);
      expect(() => store.record(pin(id))).toThrow(/no recoverable source pin/);
      expect(store.get(id)).toBeUndefined();
      expect(
        db.sqlite
          .prepare(
            "SELECT generation FROM workflow_worker_dispatches WHERE run_id = 'old-unpinned'",
          )
          .get(),
      ).toEqual({ generation: "old-run-generation" });
    }),
);
