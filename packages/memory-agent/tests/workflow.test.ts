import { Effect, Either } from "effect";
import { describe, expect, test, vi } from "vite-plus/test";
import { AppEvents } from "../src/events/app-events.ts";
import { Database } from "../src/db/database.ts";
import { WorkflowTools } from "../src/workflow/tools.ts";
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

describe("WorkflowTools live refresh", () => {
  test.each(["update_goal", "update_plan", "update_workflow_progress"])(
    "%s publishes run-state after persisting the artifact",
    async (name) => {
      const { runtime, session, project } = await testRuntime();
      const workflows = await runtime.runPromise(Workflows);
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* workflows.updateGoal(session.id, goal);
          yield* workflows.updatePlan(session.id, plan);
          yield* workflows.setPhase(session.id, "execute");
        }),
      );
      const events = await runtime.runPromise(AppEvents);
      const beforeRevision = events.revision();
      const persistedAtPublish: unknown[] = [];
      const publishSession = events.publishSession;
      const publish = vi.spyOn(events, "publishSession").mockImplementation((id, topic) => {
        persistedAtPublish.push(Effect.runSync(workflows.get(id)));
        return publishSession(id, topic);
      });
      const tools = (await runtime.runPromise(WorkflowTools)).forSession(
        session.id,
        name === "update_goal" ? "goal" : "execute",
      );
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool?.execute) throw new Error(`Missing server tool: ${name}`);
      const input =
        name === "update_goal"
          ? { ...goal, statement: "Revised goal" }
          : name === "update_plan"
            ? { ...plan, summary: "Revised plan" }
            : {
                steps: [{ id: "store", status: "in_progress", evidence: [] }],
                goalEvidence: [],
                planEvidence: [],
                detail: "Started implementation",
              };

      const result = await tool.execute(input);
      const state = await runtime.runPromise(workflows.get(session.id));

      expect(publish).toHaveBeenCalledExactlyOnceWith(session.id, "run-state");
      expect(publish.mock.results[0]?.value).toEqual({
        scope: "session",
        projectId: project.id,
        sessionId: session.id,
        topic: "run-state",
        revision: beforeRevision + 1,
      });
      expect(persistedAtPublish).toEqual([state]);
      expect(result).toMatchObject({ phase: state.phase });
      expect(state.goal?.version).toBe(name === "update_goal" ? 2 : 1);
      expect(state.plan?.version).toBe(name === "update_plan" ? 2 : 1);
      if (name === "update_goal") expect(state.goal?.statement).toBe("Revised goal");
      if (name === "update_plan") expect(state.plan?.summary).toBe("Revised plan");
      if (name === "update_workflow_progress")
        expect(state.plan?.steps[0]?.status).toBe("in_progress");
    },
  );

  test("rejected progress does not publish a successful mutation event", async () => {
    const { runtime, session } = await testRuntime();
    const workflows = await runtime.runPromise(Workflows);
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "plan");
      }),
    );
    const before = await runtime.runPromise(workflows.get(session.id));
    const events = await runtime.runPromise(AppEvents);
    const beforeRevision = events.revision();
    const publish = vi.spyOn(events, "publishSession");
    const tools = (await runtime.runPromise(WorkflowTools)).forSession(session.id, "execute");
    const progress = tools.find((tool) => tool.name === "update_workflow_progress");
    if (!progress?.execute) throw new Error("Missing progress tool");

    expect(
      await progress.execute({
        planStatus: "executing",
        steps: [],
        goalEvidence: [],
        planEvidence: [],
        detail: "Stale progress",
      }),
    ).toEqual({ error: "workflow_progress_refused", reason: "phase_not_executable" });
    expect(publish).not.toHaveBeenCalled();
    expect(events.revision()).toBe(beforeRevision);
    expect(await runtime.runPromise(workflows.get(session.id))).toEqual(before);
  });
});

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

  test("returns Execute to Plan when the Plan is revised", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        return yield* workflows.updatePlan(session.id, {
          ...plan,
          summary: "Revised execution scope",
        });
      }),
    );

    expect(state.phase).toBe("plan");
    expect(state.plan).toMatchObject({
      version: 2,
      status: "ready",
      summary: "Revised execution scope",
      steps: [{ status: "pending", evidence: [] }],
    });
    expect(state.ledger.slice(-2)).toMatchObject([
      { kind: "plan_replanned", detail: "plan v2 (ready)" },
      { kind: "phase_changed", detail: "execute -> plan (plan revised)" },
    ]);
    expect(state.ledger.at(-1)?.sequence).toBe(state.ledger.at(-2)!.sequence + 1);
  });

  test("rejects stale execution progress after a Plan revision", async () => {
    const { runtime, session } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updatePlan(session.id, {
          ...plan,
          summary: "Revised execution scope",
        });
        const progress = yield* Effect.either(
          workflows.updateProgress(session.id, {
            goalEvidence: [],
            planEvidence: [],
            planStatus: "executing",
            steps: [],
            detail: "stale Execute tool call",
          }),
        );
        return { progress, state: yield* workflows.get(session.id) };
      }),
    );

    expect(Either.isLeft(result.progress)).toBe(true);
    if (Either.isLeft(result.progress))
      expect(result.progress.left).toMatchObject({ reason: "phase_not_executable" });
    expect(result.state).toMatchObject({
      phase: "plan",
      plan: { version: 2, status: "ready" },
    });
  });

  test("returns a typed tool result for stale progress instead of a generic execution error", async () => {
    const { runtime, session } = await testRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        const tools = (yield* WorkflowTools).forSession(session.id, "execute");
        const progress = tools.find((tool) => tool.name === "update_workflow_progress");
        if (!progress?.execute) throw new Error("progress tool has no server implementation");
        yield* workflows.updatePlan(session.id, {
          ...plan,
          summary: "Revised before stale progress arrived",
        });
        return yield* Effect.promise(() =>
          progress.execute!({
            planStatus: "executing",
            steps: [],
            goalEvidence: [],
            planEvidence: [],
            detail: "stale Execute tool call",
          }),
        );
      }),
    );

    expect(result).toEqual({
      error: "workflow_progress_refused",
      reason: "phase_not_executable",
    });
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

  test("controls a Goal and records pause, resume and stop", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.setPhase(session.id, "goal");
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.controlGoal(session.id, "pause");
        yield* workflows.controlGoal(session.id, "resume");
        return yield* workflows.controlGoal(session.id, "stop");
      }),
    );

    expect(state.goal?.status).toBe("failed");
    expect(state.ledger.slice(-3).map((event) => event.kind)).toEqual([
      "goal_paused",
      "goal_resumed",
      "workflow_stopped",
    ]);
  });

  test("keeps Execute active while any Plan step lacks completion evidence", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        return yield* workflows.finishRun(session.id, "execute");
      }),
    );

    expect(state.phase).toBe("execute");
    expect(state.plan?.steps[0]?.status).toBe("pending");
  });

  test("reconciles a stale Verify phase with unfinished steps back to Execute", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.setPhase(session.id, "verify");
        return yield* workflows.reconcile(session.id);
      }),
    );

    expect(state.phase).toBe("execute");
    expect(state.ledger.at(-1)?.detail).toBe("verify -> execute (state reconciled)");
  });

  test("reconciles completed Execute work to Verify before the next turn", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        return yield* workflows.reconcile(session.id);
      }),
    );

    expect(state.phase).toBe("verify");
    expect(state.ledger.at(-1)?.detail).toBe("execute -> verify (state reconciled)");
  });

  test("advances Execute to Verify only after every step has completion evidence", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        return yield* workflows.finishRun(session.id, "execute");
      }),
    );

    expect(state.phase).toBe("verify");
    expect(state.plan?.status).toBe("executing");
    expect(state.ledger.at(-1)).toMatchObject({
      kind: "phase_changed",
      detail: "execute -> verify",
    });
  });

  test("completes verified artifacts after the Verify run", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["workflow test passed"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          verification: {
            status: "passed",
            summary: "Acceptance criteria passed",
            evidence: ["workflow test passed"],
          },
          detail: "Verification passed",
        });
        return yield* workflows.finishRun(session.id, "verify");
      }),
    );

    expect(state.phase).toBe("verify");
    expect(state.goal).toMatchObject({ status: "completed", verification: { status: "passed" } });
    expect(state.plan).toMatchObject({ status: "completed", verification: { status: "passed" } });
  });

  test.each([
    ["failed", "execute"],
    ["invalid_criterion", "plan"],
    ["inconclusive", "plan"],
  ] as const)("routes %s verification to %s", async (status, expectedPhase) => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          verification: {
            status,
            summary: `Verification ended as ${status}`,
            evidence: ["diagnostic evidence"],
          },
          detail: `Recorded ${status}`,
        });
        return yield* workflows.finishRun(session.id, "verify");
      }),
    );

    expect(state.phase).toBe(expectedPhase);
    expect(state.goal?.status).toBe("active");
    expect(state.plan?.status).toBe("executing");
    expect(state.ledger.at(-1)).toMatchObject({
      kind: "phase_changed",
      detail: `verify -> ${expectedPhase} (${status})`,
    });
    if (status === "invalid_criterion")
      expect(state.ledger.at(-2)?.kind).toBe("verification_invalidated");
  });

  test("routes an invalid hypothesis to its requested recovery phase", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          verification: {
            status: "invalid_hypothesis",
            summary: "The Goal premise was disproven",
            evidence: ["The observed failure has a different cause"],
            recoveryPhase: "goal",
          },
          detail: "Invalidate the premise and revise the Goal",
        });
        return yield* workflows.finishRun(session.id, "verify");
      }),
    );

    expect(state.phase).toBe("goal");
    expect(state.ledger.at(-2)?.kind).toBe("verification_invalidated");
    expect(state.ledger.at(-1)?.detail).toBe("verify -> goal (invalid_hypothesis)");
  });

  test("keeps a confirmed external block in Verify and marks the Plan blocked", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          verification: {
            status: "blocked",
            summary: "A real account login is required",
            evidence: ["The provider returned an authentication challenge"],
          },
          detail: "Waiting for the user to authenticate",
        });
        return yield* workflows.finishRun(session.id, "verify");
      }),
    );

    expect(state.phase).toBe("verify");
    expect(state.plan?.status).toBe("blocked");
    expect(state.plan?.verification.status).toBe("blocked");
  });

  test("does not route a verification outcome without evidence", async () => {
    const { runtime, session } = await testRuntime();
    const state = await runtime.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        yield* workflows.updateGoal(session.id, goal);
        yield* workflows.updatePlan(session.id, plan);
        yield* workflows.setPhase(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [{ id: "store", status: "completed", evidence: ["implementation evidence"] }],
          goalEvidence: [],
          planEvidence: [],
          detail: "Implementation complete",
        });
        yield* workflows.finishRun(session.id, "execute");
        yield* workflows.updateProgress(session.id, {
          steps: [],
          goalEvidence: [],
          planEvidence: [],
          verification: {
            status: "invalid_criterion",
            summary: "Unsupported invalidation claim",
            evidence: [],
          },
          detail: "Tried to invalidate without evidence",
        });
        return yield* workflows.finishRun(session.id, "verify");
      }),
    );

    expect(state.phase).toBe("verify");
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
