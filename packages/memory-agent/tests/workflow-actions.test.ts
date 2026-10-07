import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { describe, expect } from "vite-plus/test";
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

const setup = Effect.fnUntraced(function* () {
  const context = yield* Effect.promise(() => testRuntime());
  const { runtime, session } = context;
  const services = yield* Effect.provideContext(
    Effect.all({ workflows: Workflows, db: Database, agent: AgentChat }),
    yield* runtime.contextEffect,
  );
  yield* services.workflows.updateGoal(session.id, goal);
  const state = yield* services.workflows.updatePlan(session.id, plan);
  return { ...context, ...services, state };
});

describe("server workflow action policy", () => {
  it.effect(
    "advertised decisions match serialized persisted mutations across lifecycle states",
    () =>
      Effect.gen(function* () {
        const {
          session,
          workflows,
          state,
          db: { sqlite },
        } = yield* setup();
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
            const result = yield* Effect.result(workflows.setPhase(session.id, phase));
            const decision = advertised.phases[phase];
            expect(Result.isSuccess(result)).toBe(decision.allowed);
            if (!decision.allowed && Result.isFailure(result))
              expect(result.failure.reason).toBe(decision.reason);
            if (!decision.allowed) expect(yield* workflows.get(session.id)).toEqual(current);
          }
          for (const action of ["pause", "resume", "stop"] as const) {
            reset(current);
            const result = yield* Effect.result(workflows.controlGoal(session.id, action));
            const decision = advertised.controls[action];
            expect(Result.isSuccess(result)).toBe(decision.allowed);
            if (!decision.allowed && Result.isFailure(result))
              expect(result.failure.reason).toBe(decision.reason);
            if (!decision.allowed) expect(yield* workflows.get(session.id)).toEqual(current);
          }
        }
      }),
  );

  it.effect(
    "rejects an advertised Execute after the goal changes, without a client version check",
    () =>
      Effect.gen(function* () {
        const { session, workflows, state } = yield* setup();
        expect(workflowActions(state).phases.execute).toEqual({ allowed: true, intent: "start" });
        yield* workflows.updateGoal(session.id, { ...goal, statement: "Changed" });
        const result = yield* Effect.result(workflows.setPhase(session.id, "execute"));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.reason).toBe("plan_outdated");
      }),
  );

  it.effect("keeps Plan + executing resumable without resetting progress", () =>
    Effect.gen(function* () {
      const { session, workflows } = yield* setup();
      yield* workflows.setPhase(session.id, "execute");
      const state = yield* workflows.setPhase(session.id, "plan");
      expect(workflowActions(state).phases.execute).toEqual({ allowed: true, intent: "continue" });
      const continued = yield* workflows.setPhase(session.id, "execute");
      expect(continued.plan).toEqual(state.plan);
    }),
  );

  it.effect("running denies navigation and resume but preserves pause/stop cancellation", () =>
    Effect.gen(function* () {
      const { state } = yield* setup();
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
    }),
  );

  it.effect("GET exposes the same policy with the requesting page's lease", () =>
    Effect.gen(function* () {
      const { session, agent } = yield* setup();
      yield* agent.lease(session.id, "owner", "claim");
      for (const holder of ["owner", "observer"]) {
        const response = yield* agent.status(session.id, holder);
        expect(response.status).toBe(200);
        // SAFETY: the successful in-process status handler constructs a typed SessionRunState.
        const snapshot = (yield* Effect.promise(() => response.json())) as SessionRunState;
        expect(snapshot.actions).toEqual(
          workflowActions(snapshot.workflow, {
            lease: snapshot.lease,
            running: snapshot.running !== null,
          }),
        );
        const changed = yield* agent.setWorkflowPhase(session.id, holder, "execute");
        expect(changed.status).toBe(snapshot.actions.phases.execute.allowed ? 200 : 423);
      }
    }),
  );
});
