import { DateTime, Effect, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { goalWorkerAuthority } from "../../src/agent/goal-worker-authority.ts";
import { goalWorkerGenerationStore } from "../../src/agent/goal-worker-generation-store.ts";
import { Database } from "../../src/db/database.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { type Admission, workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const goal = (statement: string) => ({
  statement,
  outcomes: ["No stale worker effect"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
});

/**
 * A fresh session with an active Goal, read through `env.use` so it follows the agent across
 * `env.reopen`. Run IDs are global, so callers prefix them with the session.
 */
const withGoal = Effect.gen(function* () {
  const env = yield* TestEnv;
  return yield* env.use(
    Effect.gen(function* () {
      const session = (yield* (yield* Sessions).create(env.project.id)).id;
      yield* (yield* Workflows).updateGoal(session, goal("Original Goal"));
      return session;
    }),
  );
});

const goalId = (db: Database["Service"], session: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ goal_instance_id: Schema.String }))(
    db.sqlite
      .prepare("SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?")
      .get(session),
  ).pipe(Effect.map((row) => row.goal_instance_id));

/** Bind a run to the session's latest revision. */
const bindLatest = Effect.fnUntraced(function* (session: string, runId: string) {
  const db = yield* Database;
  const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
      .get(session),
  );
  return boundRun(yield* (yield* workflowRunBindings).bind(session, runId, revision.id));
});

const boundRun = (admission: Admission) => {
  switch (admission.status) {
    case "bound":
      return admission.binding;
    case "refused":
      return expect.unreachable(`run refused: ${admission.reason}`);
  }
};

const recordRun = (db: Database["Service"], session: string, runId: string, status: string) =>
  db.sqlite
    .prepare("INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)")
    .run(runId, session, status, DateTime.toEpochMillis(DateTime.nowUnsafe()));

const dispatchOf = (db: Database["Service"], runId: string) =>
  db.sqlite
    .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
    .get(runId);

const pin = (goalInstanceId: string) => ({
  goalInstanceId,
  sourceGeneration: `source-${goalInstanceId}`,
  manifestHash: "a".repeat(64),
  workerUrl: "file:///test-only/source-v1/full-loop-worker.ts",
});

testAgent()("Goal worker authority", (it) => {
  it.effect("owner capability fences session, revision, generation and completed runs", () =>
    Effect.gen(function* () {
      const db = yield* Database;
      const session = yield* withGoal;
      const binding = yield* bindLatest(session, `${session}:pinned`);
      const owner = yield* goalWorkerAuthority;
      const first = yield* owner.issue(binding, "worker-generation-1");
      if (first === null) return expect.unreachable("expected worker capability");
      const original = { ...first };
      expect(Object.isFrozen(first)).toBe(true);
      for (const [field, value] of Object.entries({
        token: "replacement-token",
        generation: "replacement-generation",
        sessionId: "replacement-session",
        runId: "replacement-run",
        goalInstanceId: "replacement-goal",
        goalVersion: 2,
        planVersion: 2,
        workflowRevisionId: 2,
      })) {
        expect(Reflect.set(first, field, value)).toBe(false);
      }
      expect(first).toEqual(original);
      expect(yield* owner.permits({ ...first, requestId: "tool-call-1" })).toBe(true);
      expect(yield* owner.permits({ ...first, requestId: "" })).toBe(false);
      expect(
        yield* owner.permits({ ...first, sessionId: "another-session", requestId: "tool-call-1" }),
      ).toBe(false);
      expect(yield* owner.permits({ ...first, goalVersion: 2, requestId: "tool-call-1" })).toBe(
        false,
      );
      expect(
        yield* owner.permits({
          ...first,
          generation: "worker-generation-2",
          requestId: "tool-call-1",
        }),
      ).toBe(false);
      expect(yield* owner.issue(binding, "worker-generation-2")).toBeNull();
      recordRun(db, session, first.runId, "completed");
      expect(yield* owner.permits({ ...first, requestId: "late-tool" })).toBe(false);
      expect(yield* owner.permitsFinalization({ ...first, requestId: "record-finish" })).toBe(true);
      for (const patch of [
        { token: "wrong" },
        { generation: "wrong" },
        { sessionId: "wrong" },
        { runId: "wrong" },
        { goalInstanceId: "wrong" },
        { goalVersion: 2 },
        { planVersion: 2 },
        { workflowRevisionId: 2 },
      ])
        expect(
          yield* owner.permitsFinalization({ ...first, ...patch, requestId: "record-finish" }),
        ).toBe(false);
      db.sqlite.prepare("DELETE FROM chat_runs WHERE run_id = ?").run(first.runId);
      owner.revoke(first.runId);
      expect(yield* owner.permitsFinalization({ ...first, requestId: "record-finish" })).toBe(
        false,
      );
      expect(yield* owner.permits({ ...first, requestId: "late-result" })).toBe(false);
      // Revoking an uncertain attempt must not silently issue another generation.
      expect(yield* owner.issue(binding, "worker-generation-2")).toBeNull();
      // Restarting the owner loses the token but retains the dispatch marker.
      const replacementOwner = yield* goalWorkerAuthority;
      expect(yield* replacementOwner.permits({ ...first, requestId: "old-owner" })).toBe(false);
      expect(yield* replacementOwner.issue(binding, "worker-generation-2")).toBeNull();
      expect(dispatchOf(db, first.runId)).toEqual({ generation: "worker-generation-1" });
      recordRun(db, session, first.runId, "failed");
      expect(yield* owner.permits({ ...first, requestId: "late-result" })).toBe(false);
    }),
  );

  it.effect("a source pin is immutable and replacement cannot erase its evidence", () =>
    Effect.gen(function* () {
      const db = yield* Database;
      const id = yield* goalId(db, yield* withGoal);
      const store = yield* goalWorkerGenerationStore;
      yield* store.record(pin(id));
      expect(
        yield* Effect.flip(store.record({ ...pin(id), sourceGeneration: "replacement" })),
      ).toMatchObject({ reason: "already_pinned" });
      expect(() =>
        db.sqlite
          .prepare(
            "UPDATE workflow_goal_worker_generations SET source_generation = 'replacement' WHERE goal_instance_id = ?",
          )
          .run(id),
      ).toThrow(/immutable/);
      expect(() =>
        db.sqlite
          .prepare("DELETE FROM workflow_goal_worker_generations WHERE goal_instance_id = ?")
          .run(id),
      ).toThrow(/immutable/);
      expect(yield* store.pinned(id)).toEqual(Option.some(pin(id)));
    }),
  );

  it.effect(
    "historical unpinned dispatch stays unbound instead of silently acquiring current code",
    () =>
      Effect.gen(function* () {
        const db = yield* Database;
        const session = yield* withGoal;
        const runId = `${session}:old-unpinned`;
        const binding = yield* bindLatest(session, runId);
        expect(
          yield* (yield* goalWorkerAuthority).issue(binding, "old-run-generation"),
        ).not.toBeNull();
        const id = yield* goalId(db, session);
        const store = yield* goalWorkerGenerationStore;
        expect(yield* Effect.flip(store.pinned(id))).toMatchObject({ reason: "unrecoverable_pin" });
        expect(yield* Effect.flip(store.record(pin(id)))).toMatchObject({
          reason: "unrecoverable_pin",
        });
        expect(
          db.sqlite
            .prepare(
              "SELECT count(*) AS n FROM workflow_goal_worker_generations WHERE goal_instance_id = ?",
            )
            .get(id),
        ).toEqual({ n: 0 });
        expect(dispatchOf(db, runId)).toEqual({ generation: "old-run-generation" });
      }),
  );
});

// Reopening replaces the agent, so this block reads services through `env.use` only.
testAgent()("Goal worker source generation across reopen", (it) => {
  it.effect(
    "source generation persists across Goal amendments and owner reopen, independently of run tokens",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const session = yield* withGoal;
        const db = yield* env.use(Database);
        const id = yield* goalId(db, session);
        const store = yield* env.use(goalWorkerGenerationStore);
        expect(yield* store.record(pin(id))).toEqual(pin(id));
        yield* env.use(
          Effect.flatMap(Workflows, (workflows) =>
            workflows.updateGoal(session, goal("Amended outcome, same Goal")),
          ),
        );
        expect(yield* goalId(db, session)).toBe(id);
        expect(yield* store.pinned(id)).toEqual(Option.some(pin(id)));
        yield* env.reopen;
        const restored = yield* env.use(Database);
        expect(yield* (yield* env.use(goalWorkerGenerationStore)).pinned(id)).toEqual(
          Option.some(pin(id)),
        );
        expect(
          restored.sqlite
            .prepare(
              "SELECT count(*) AS n FROM workflow_worker_dispatches d JOIN workflow_run_bindings b USING (run_id) WHERE b.session_id = ?",
            )
            .get(session),
        ).toEqual({ n: 0 });
      }),
  );
});
