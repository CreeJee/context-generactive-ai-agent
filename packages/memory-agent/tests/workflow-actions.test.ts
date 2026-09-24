import { Effect, Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import type { SessionRunState } from "../src/agent/run-state.ts";
import { Database } from "../src/db/database.ts";
import { evaluateWorkflowAction, workflowActions } from "../src/workflow/actions.ts";
import { Workflows, type WorkflowState } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "Ship",
  outcomes: ["Works"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const plan = {
  summary: "Build",
  steps: [],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

async function setup() {
  const context = await testRuntime();
  const { runtime, session } = context;
  const workflows = await runtime.runPromise(Workflows);
  await runtime.runPromise(workflows.updateGoal(session.id, goal));
  const state = await runtime.runPromise(workflows.updatePlan(session.id, plan));
  return { ...context, workflows, state };
}

describe("server workflow action policy", () => {
  test("advertised decisions match serialized persisted mutations across lifecycle states", async () => {
    const { runtime, session, workflows, state } = await setup();
    const { sqlite } = await runtime.runPromise(Database);
    const states: WorkflowState[] = [
      { ...state, goal: null, plan: null },
      { ...state, plan: null },
      ...(["draft", "active", "paused", "completed", "failed"] as const).map((status) => ({
        ...state,
        goal: { ...state.goal!, status },
      })),
      ...(["draft", "ready", "executing", "completed", "blocked"] as const).map((status) => ({
        ...state,
        plan: { ...state.plan!, status },
      })),
      { ...state, goal: { ...state.goal!, version: 2 } },
      { ...state, phase: "plan", plan: { ...state.plan!, status: "executing" } },
      { ...state, phase: "verify", plan: { ...state.plan!, status: "executing" } },
    ];
    const reset = (current: WorkflowState) =>
      sqlite
        .prepare("UPDATE session_workflows SET state_json = ? WHERE session_id = ?")
        .run(JSON.stringify(current), session.id);
    for (const current of states) {
      const advertised = workflowActions(current);
      for (const phase of ["chat", "goal", "plan", "execute", "verify"] as const) {
        reset(current);
        const result = await runtime.runPromise(
          Effect.result(workflows.setPhase(session.id, phase)),
        );
        const decision = advertised.phases[phase];
        expect(Result.isSuccess(result)).toBe(decision.allowed);
        if (!decision.allowed && Result.isFailure(result))
          expect(result.failure.reason).toBe(decision.reason);
        if (!decision.allowed)
          expect(await runtime.runPromise(workflows.get(session.id))).toEqual(current);
      }
      for (const action of ["pause", "resume", "stop"] as const) {
        reset(current);
        const result = await runtime.runPromise(
          Effect.result(workflows.controlGoal(session.id, action)),
        );
        const decision = advertised.controls[action];
        expect(Result.isSuccess(result)).toBe(decision.allowed);
        if (!decision.allowed && Result.isFailure(result))
          expect(result.failure.reason).toBe(decision.reason);
        if (!decision.allowed)
          expect(await runtime.runPromise(workflows.get(session.id))).toEqual(current);
      }
    }
  });

  test("rejects an advertised Execute after the goal changes, without a client version check", async () => {
    const { runtime, session, workflows, state } = await setup();
    expect(workflowActions(state).phases.execute).toEqual({ allowed: true, intent: "start" });
    await runtime.runPromise(workflows.updateGoal(session.id, { ...goal, statement: "Changed" }));
    const result = await runtime.runPromise(
      Effect.result(workflows.setPhase(session.id, "execute")),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("plan_outdated");
  });

  test("keeps Plan + executing resumable without resetting progress", async () => {
    const { runtime, session, workflows } = await setup();
    await runtime.runPromise(workflows.setPhase(session.id, "execute"));
    const state = await runtime.runPromise(workflows.setPhase(session.id, "plan"));
    expect(workflowActions(state).phases.execute).toEqual({ allowed: true, intent: "continue" });
    const continued = await runtime.runPromise(workflows.setPhase(session.id, "execute"));
    expect(continued.plan).toEqual(state.plan);
  });

  test("running denies navigation and resume but preserves pause/stop cancellation", async () => {
    const { state } = await setup();
    const actions = workflowActions(state, { running: true, lease: { state: "mine" } });
    for (const decision of Object.values(actions.phases))
      expect(decision).toEqual({ allowed: false, reason: "run_in_progress" });
    expect(actions.controls.resume).toEqual({ allowed: false, reason: "run_in_progress" });
    expect(actions.controls.pause.allowed).toBe(true);
    expect(actions.controls.stop.allowed).toBe(true);
    const held = workflowActions(state, { running: true, lease: { state: "other", since: 0 } });
    for (const decision of [...Object.values(held.phases), ...Object.values(held.controls)])
      expect(decision).toEqual({ allowed: false, reason: "session_in_use" });
    expect(
      evaluateWorkflowAction(
        state,
        { kind: "phase", phase: "execute" },
        { lease: { state: "free" } },
      ).allowed,
    ).toBe(true);
  });

  test("GET exposes the same policy with the requesting page's lease", async () => {
    const { runtime, session } = await setup();
    const agent = await runtime.runPromise(AgentChat);
    await runtime.runPromise(agent.lease(session.id, "owner", "claim"));
    for (const holder of ["owner", "observer"]) {
      const response = await runtime.runPromise(agent.status(session.id, holder));
      expect(response.status).toBe(200);
      // SAFETY: the successful in-process status handler constructs a typed SessionRunState.
      const snapshot = (await response.json()) as SessionRunState;
      expect(snapshot.actions).toEqual(
        workflowActions(snapshot.workflow, {
          lease: snapshot.lease,
          running: snapshot.running !== null,
        }),
      );
      const changed = await runtime.runPromise(
        agent.setWorkflowPhase(session.id, holder, "execute"),
      );
      expect(changed.status).toBe(snapshot.actions.phases.execute.allowed ? 200 : 423);
    }
  });
});
