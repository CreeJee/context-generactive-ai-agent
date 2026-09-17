import { Effect, Either } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "Ship a durable planning workflow",
  outcomes: ["A plan survives reloads"],
  constraints: ["Keep prompts thin"],
  nonGoals: ["Automatic execution"],
  assumptions: ["A session owns one active workflow"],
  openQuestions: [],
  status: "active" as const,
};

const plan = {
  summary: "Persist and expose workflow artifacts",
  steps: [
    {
      id: "store",
      title: "Store artifacts",
      description: "Persist versioned state outside the transcript",
      dependsOn: [],
      acceptanceCriteria: ["State survives a process restart"],
      ruleRefs: ["workflow.thin-context"],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

describe("Workflows", () => {
  test("versions artifacts and starts a ready Plan on Execute", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.setPhase(session.id, "goal");
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.setPhase(session.id, "plan");
        yield* workflows.updatePlan(session.id, plan);
        return yield* workflows.setPhase(session.id, "execute");
      }),
    );

    expect(state.phase).toBe("execute");
    expect(state.goal).toMatchObject({ version: 1, status: "active" });
    expect(state.plan).toMatchObject({
      version: 1,
      goalVersion: 1,
      status: "executing",
    });
    expect(state.ledger.map((event) => event.kind)).toEqual([
      "phase_changed",
      "goal_updated",
      "phase_changed",
      "plan_updated",
      "phase_changed",
    ]);
  });

  test("keeps an older Plan visibly tied to its Goal version", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.updateGoal(session.id, { ...goal, statement: "Changed goal" });
        return yield* workflows.get(session.id);
      }),
    );

    expect(state.goal?.version).toBe(2);
    expect(state.plan?.goalVersion).toBe(1);

    const execute = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Effect.either((yield* Workflows).setPhase(session.id, "execute"));
      }),
    );
    expect(Either.isLeft(execute)).toBe(true);
  });

  test("upgrades persisted legacy statuses and missing evidence fields", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        sqlite
          .prepare(
            "INSERT INTO session_workflows (session_id, state_json, updated_at) VALUES (?, ?, ?)",
          )
          .run(
            session.id,
            JSON.stringify({
              phase: "execute",
              goal: {
                version: 1,
                statement: goal.statement,
                outcomes: goal.outcomes,
                constraints: goal.constraints,
                nonGoals: goal.nonGoals,
                assumptions: goal.assumptions,
                openQuestions: [],
                status: "confirmed",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              plan: {
                version: 1,
                goalVersion: 1,
                summary: plan.summary,
                steps: [{ ...plan.steps[0], status: "pending" }],
                risks: [],
                openQuestions: [],
                status: "approved",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              ledger: [],
            }),
            "2026-01-01T00:00:00.000Z",
          );
        return yield* (yield* Workflows).get(session.id);
      }),
    );

    expect(state.goal).toMatchObject({
      status: "active",
      evidence: [],
      verification: { status: "not_run" },
    });
    expect(state.plan).toMatchObject({
      status: "executing",
      evidence: [],
      verification: { status: "not_run" },
      steps: [{ status: "pending", evidence: [] }],
    });
  });

  test("does not lose versions under concurrent updates", async () => {
    const { runtime, session } = await testRuntime();
    const count = 24;
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* Effect.all(
          Array.from({ length: count }, (_, index) =>
            workflows.updateGoal(session.id, {
              ...goal,
              statement: `Concurrent goal ${index + 1}`,
            }),
          ),
          { concurrency: "unbounded" },
        );
        return yield* workflows.get(session.id);
      }),
    );

    expect(state.goal?.version).toBe(count);
    const goalEvents = state.ledger.filter((event) => event.kind === "goal_updated");
    expect(goalEvents).toHaveLength(count);
    expect(goalEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });

  test("records step evidence and requires passed verification before completion", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["workflow.test.ts passed"] }],
          goalEvidence: [],
          planEvidence: ["State persisted after reload"],
          detail: "Completed the storage step",
        });
        return yield* workflows.updateProgress(session.id, {
          goalStatus: "completed",
          planStatus: "completed",
          steps: [],
          goalEvidence: ["The requested workflow is available"],
          planEvidence: [],
          verification: {
            status: "passed",
            summary: "The workflow persists and reloads",
            evidence: ["24 workflow assertions passed"],
          },
          detail: "Verification passed",
        });
      }),
    );

    expect(state.goal).toMatchObject({
      status: "completed",
      verification: { status: "passed" },
    });
    expect(state.plan).toMatchObject({
      status: "completed",
      verification: { status: "passed" },
      steps: [{ id: "store", status: "completed", evidence: ["workflow.test.ts passed"] }],
    });
    expect(state.ledger.at(-1)?.kind).toBe("verification_recorded");
  });

  test("refuses unsupported completion claims", async () => {
    const { runtime, session } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        return yield* Effect.either(
          workflows.updateProgress(session.id, {
            goalStatus: "completed",
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            verification: {
              status: "passed",
              summary: "Claimed success",
              evidence: [],
            },
            detail: "Tried to complete without evidence",
          }),
        );
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.reason).toBe("verification_required");
  });

  test("refuses a completed step without evidence", async () => {
    const { runtime, session } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        return yield* Effect.either(
          workflows.updateProgress(session.id, {
            steps: [{ id: "store", status: "completed", evidence: [] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Claimed the step was done",
          }),
        );
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.reason).toBe("step_evidence_required");
  });

  test("records pause and resume as durable Goal lifecycle events", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updateProgress(session.id, {
          goalStatus: "paused",
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          detail: "Paused by the user",
        });
        return yield* workflows.updateProgress(session.id, {
          goalStatus: "active",
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          detail: "Resumed by the user",
        });
      }),
    );

    expect(state.goal?.status).toBe("active");
    expect(state.ledger.slice(-2).map((event) => event.kind)).toEqual([
      "goal_paused",
      "goal_resumed",
    ]);
  });

  test("refuses Execute until a Plan is ready", async () => {
    const { runtime, session } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Effect.either((yield* Workflows).setPhase(session.id, "execute"));
      }),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.reason).toBe("plan_not_ready");
  });
});
