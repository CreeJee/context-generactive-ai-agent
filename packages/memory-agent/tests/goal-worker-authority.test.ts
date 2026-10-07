import { it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { goalWorkerAuthority } from "../src/agent/goal-worker-authority.ts";
import { Database } from "../src/db/database.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "Preserve the pinned Goal",
  outcomes: ["No stale worker effect"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

it.effect("owner capability fences session, revision, generation and completed runs", () =>
  Effect.gen(function* () {
    const context = yield* Effect.promise(() => testRuntime());
    const { db, workflows } = yield* Effect.provideContext(
      Effect.all({ db: Database, workflows: Workflows }),
      yield* context.runtime.contextEffect,
    );
    yield* workflows.updateGoal(context.session.id, goal);
    const revision = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
      db.sqlite
        .prepare(
          "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(context.session.id),
    );
    const admitted = workflowRunBindings(db).bind(context.session.id, "pinned-run", revision.id);
    expect(admitted.status).toBe("bound");
    if (admitted.status !== "bound") return yield* Effect.die("expected bound run");
    const owner = goalWorkerAuthority(db);
    const first = owner.issue(admitted.binding, "worker-generation-1");
    expect(first).not.toBeNull();
    if (first === null) return yield* Effect.die("expected worker capability");
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
    expect(owner.permits({ ...original, requestId: "original-authority" })).toBe(true);
    expect(owner.permits({ ...first, requestId: "tool-call-1" })).toBe(true);
    expect(owner.permits({ ...first, requestId: "" })).toBe(false);
    expect(
      owner.permits({ ...first, sessionId: "another-session", requestId: "tool-call-1" }),
    ).toBe(false);
    expect(owner.permits({ ...first, goalVersion: 2, requestId: "tool-call-1" })).toBe(false);
    expect(
      owner.permits({ ...first, generation: "worker-generation-2", requestId: "tool-call-1" }),
    ).toBe(false);
    expect(owner.issue(admitted.binding, "worker-generation-2")).toBeNull();
    db.sqlite
      .prepare(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', ?)",
      )
      .run(first.runId, context.session.id, DateTime.toEpochMillis(yield* DateTime.now));
    expect(owner.permits({ ...first, requestId: "late-tool" })).toBe(false);
    expect(owner.permitsFinalization({ ...first, requestId: "record-finish" })).toBe(true);
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
      expect(owner.permitsFinalization({ ...first, ...patch, requestId: "record-finish" })).toBe(
        false,
      );
    db.sqlite.prepare("DELETE FROM chat_runs WHERE run_id = ?").run(first.runId);
    owner.revoke(first.runId);
    expect(owner.permitsFinalization({ ...first, requestId: "record-finish" })).toBe(false);
    expect(owner.permits({ ...first, requestId: "late-result" })).toBe(false);
    // Revoking an uncertain attempt must not silently issue another generation.
    expect(owner.issue(admitted.binding, "worker-generation-2")).toBeNull();
    expect(owner.permits({ ...first, requestId: "late-result" })).toBe(false);
    // Restarting the owner loses the token but retains the dispatch marker.
    const replacementOwner = goalWorkerAuthority(db);
    expect(replacementOwner.permits({ ...first, requestId: "old-owner" })).toBe(false);
    expect(replacementOwner.issue(admitted.binding, "worker-generation-2")).toBeNull();
    expect(
      db.sqlite
        .prepare("SELECT generation FROM workflow_worker_dispatches WHERE run_id = ?")
        .get(first.runId),
    ).toEqual({ generation: "worker-generation-1" });
    db.sqlite
      .prepare(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'failed', ?)",
      )
      .run(first.runId, context.session.id, DateTime.toEpochMillis(yield* DateTime.now));
    expect(owner.permits({ ...first, requestId: "late-result" })).toBe(false);
  }),
);
