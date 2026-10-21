import { Cause, Effect, FileSystem, Path, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { isTruthy } from "../../src/truthy.ts";
import { GoalExecution, GoalExecutions } from "../../src/workflow/goal-execution.ts";
import { GoalExecutionPayload } from "../../src/workflow/goal-execution-contracts.ts";
import { workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { WorkflowTools } from "../../src/workflow/tools.ts";
import {
  type UpdateWorkflowProgress,
  Workflows,
  WorkflowState,
} from "../../src/workflow/workflow.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { inRun } from "../support/run-span.ts";
import { sqlGet, sqlRun } from "../support/sql.ts";

const goal = {
  statement: "Verified Goal",
  outcomes: ["Outcome A", "Outcome B"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const plan = {
  summary: "Current Plan",
  steps: [
    {
      id: "step",
      title: "Verify",
      description: "Check",
      dependsOn: [],
      acceptanceCriteria: ["Actual verification"],
      ruleRefs: [],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};
const verifiedProgress: UpdateWorkflowProgress = {
  steps: [{ id: "step", status: "completed", evidence: ["proof"] }],
  goalEvidence: ["proof"],
  planEvidence: ["proof"],
  verification: { status: "passed", summary: "Focused check passed", evidence: ["proof"] },
  detail: "Verified outcomes",
};
const noMappings: UpdateWorkflowProgress = {
  ...verifiedProgress,
  goalStatus: "completed",
  planStatus: "completed",
};

type Registration = "native" | "legacy";

/**
 * A fresh session whose Goal is executing and bound to its own completed run with one successful
 * proof node. Every row is keyed by the session, so tests share the agent without colliding.
 */
const fixture = Effect.fnUntraced(function* (registration: Registration) {
  const { project } = yield* TestEnv;
  const workflows = yield* Workflows;
  const sessionId = (yield* (yield* Sessions).create(project.id)).id;
  const run = `run-${sessionId}`;
  const proof = `proof-${sessionId}`;
  const source = `source-${sessionId}`;
  yield* workflows.updateGoal(sessionId, goal);
  yield* workflows.updatePlan(sessionId, plan);
  yield* workflows.setPhase(sessionId, "execute");
  const goalId = yield* workflows.goalInstanceId(sessionId);
  if (goalId === null) return yield* Effect.die("Expected Goal identity");
  const revision = Number(
    (yield* sqlGet(
      "SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?",
      sessionId,
    ))!.id,
  );
  const bind = (yield* workflowRunBindings).bind(sessionId, run, revision);
  switch (registration) {
    case "native": {
      yield* sqlRun(
        "INSERT INTO workflow_goal_native_artifacts VALUES (?, ?, ?, ?, ?, ?)",
        goalId,
        "file:///owner/native.mjs",
        "a".repeat(64),
        "native-v1",
        "b".repeat(64),
        "2026-10-07T00:00:00.000Z",
      );
      yield* sqlRun(
        "INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)",
        goalId,
        source,
        "c".repeat(64),
        "file:///owner/worker.mjs",
        "2026-10-07T00:00:00.000Z",
      );
      const goals = yield* GoalExecutions;
      const payload = GoalExecutionPayload.make({
        identity: {
          owner: { ownerId: project.id, generation: "test-owner-generation" },
          sessionId,
          runId: run,
          goalInstanceId: goalId,
          workflowRevisionId: revision,
        },
      });
      expect((yield* goals.admitAndStart(payload, bind)).type).toBe("admitted");
      yield* goals.succeed(payload);
      yield* GoalExecution.execute(payload);
      break;
    }
    case "legacy":
      expect((yield* bind).status).toBe("bound");
      break;
  }
  yield* sqlRun(
    "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', 1)",
    run,
    sessionId,
  );
  yield* sqlRun(
    "INSERT INTO workflow_worker_dispatches VALUES (?, ?, ?)",
    run,
    "dispatch",
    "2026-10-07T00:00:00.000Z",
  );
  yield* insertNode({ id: proof, projectId: project.id, sessionId, run, ok: true });
  const mapping = (outcomeIndex: number) => ({
    outcomeIndex,
    outcomeText: goal.outcomes[outcomeIndex]!,
    stepId: "step",
    acceptanceIndex: 0,
    acceptanceText: "Actual verification",
    runId: run,
    evidenceNodeIds: [proof],
  });
  const complete: UpdateWorkflowProgress = {
    ...noMappings,
    criterionMappings: [mapping(0), mapping(1)],
  };
  return {
    projectId: project.id,
    sessionId,
    goalId,
    run,
    proof,
    source,
    mapping,
    complete,
  };
});

type Fixture = Effect.Success<ReturnType<typeof fixture>>;

const insertNode = (node: {
  id: string;
  projectId: string;
  sessionId: string;
  run: string;
  ok: boolean;
}) =>
  sqlRun(
    `INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
      VALUES (?, ?, ?, ?, 'tool_result', 'Check result', ?, '2026-10-07T00:00:00.000Z')`,
    node.id,
    node.projectId,
    node.sessionId,
    node.run,
    JSON.stringify({ ok: node.ok }),
  );

/** The progress update fails and leaves the persisted workflow untouched. */
const refused = Effect.fnUntraced(function* (
  fx: Fixture,
  input: UpdateWorkflowProgress,
  recorder: string = fx.run,
) {
  const workflows = yield* Workflows;
  const before = yield* workflows.get(fx.sessionId);
  const result = yield* Effect.result(workflows.updateProgress(fx.sessionId, input, recorder));
  expect(Result.isFailure(result)).toBe(true);
  expect(yield* workflows.get(fx.sessionId)).toEqual(before);
});

const refusals = [
  // Evidence ownership and success.
  "other session",
  "other project",
  "missing node",
  "failed result",
  "interrupted run",
  // Criterion mapping shape.
  "missing mappings",
  "incomplete mappings",
  "foreign run node",
  "stale outcome text",
  "stale acceptance text",
  "wrong recorder",
  "empty proof",
  "wrong run",
  // Source-bound execution receipts.
  "missing execution",
  "suspended execution",
  "failed execution",
  "missing dispatch",
  "pending operation",
  "uncertain effect",
] as const;
type Refusal = (typeof refusals)[number];

const ownExecution = "json_extract(payload_json, '$.identity.sessionId') = ?";

/** Breaks one link of the completion proof and returns the progress update to attempt. */
const breakProof = Effect.fnUntraced(function* (fx: Fixture, failure: Refusal) {
  const withSecondMapping = (override: Partial<ReturnType<Fixture["mapping"]>>) => ({
    input: {
      ...fx.complete,
      criterionMappings: [fx.mapping(0), { ...fx.mapping(1), ...override }],
    },
    recorder: fx.run,
  });
  const unchanged = { input: fx.complete, recorder: fx.run };
  const badNode = `${fx.run}-bad`;
  const operation = (sideEffect: 0 | 1, reply: string, status: string) =>
    sqlRun(
      `INSERT INTO owner_rpc_operations
         (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
         VALUES (?, '{}', 1, '{}', ?, ?, ?)`,
      fx.run,
      sideEffect,
      reply,
      status,
    );
  switch (failure) {
    case "other session": {
      const { project } = yield* TestEnv;
      const other = yield* (yield* Sessions).create(project.id);
      yield* insertNode({ ...nodeOf(fx, badNode), sessionId: other.id });
      return withSecondMapping({ evidenceNodeIds: [badNode] });
    }
    case "other project": {
      const { base } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const root = (yield* Path.Path).join(base, `other-${fx.sessionId}`);
      yield* fs.makeDirectory(root);
      const other = yield* (yield* Projects).add(root);
      yield* insertNode({ ...nodeOf(fx, badNode), projectId: other.id });
      return withSecondMapping({ evidenceNodeIds: [badNode] });
    }
    case "missing node":
      return withSecondMapping({ evidenceNodeIds: [badNode] });
    case "failed result":
      yield* insertNode({ ...nodeOf(fx, badNode), ok: false });
      return withSecondMapping({ evidenceNodeIds: [badNode] });
    case "interrupted run":
      yield* sqlRun("UPDATE chat_runs SET status = 'interrupted' WHERE run_id = ?", fx.run);
      return unchanged;
    case "missing mappings":
      return { input: noMappings, recorder: fx.run };
    case "incomplete mappings":
      return {
        input: { ...fx.complete, criterionMappings: [fx.mapping(0)] },
        recorder: fx.run,
      };
    case "foreign run node": {
      const foreign = `${fx.run}-foreign`;
      yield* insertNode({ ...nodeOf(fx, foreign), run: "other" });
      return withSecondMapping({ evidenceNodeIds: [foreign] });
    }
    case "stale outcome text":
      return withSecondMapping({ outcomeText: "old" });
    case "stale acceptance text":
      return withSecondMapping({ acceptanceText: "old" });
    case "wrong recorder":
      return { input: fx.complete, recorder: "foreign" };
    case "empty proof":
      return withSecondMapping({ evidenceNodeIds: [] });
    case "wrong run":
      return withSecondMapping({ runId: "other" });
    case "missing execution":
      yield* sqlRun(`DELETE FROM owner_workflow_executions WHERE ${ownExecution}`, fx.sessionId);
      return unchanged;
    case "suspended execution":
      yield* sqlRun(
        `UPDATE owner_workflow_executions SET status = 'suspended', result_json = '{"_tag":"Suspended"}' WHERE ${ownExecution}`,
        fx.sessionId,
      );
      return unchanged;
    case "failed execution":
      yield* sqlRun(
        `UPDATE owner_workflow_executions SET status = 'completed', result_json = '{"_tag":"Complete","exit":{"_tag":"Failure"}}' WHERE ${ownExecution}`,
        fx.sessionId,
      );
      return unchanged;
    case "missing dispatch":
      yield* sqlRun("DELETE FROM workflow_worker_dispatches WHERE run_id = ?", fx.run);
      return unchanged;
    case "pending operation":
      yield* operation(0, '{"type":"pending","operationId":1}', "pending");
      return unchanged;
    case "uncertain effect":
      yield* operation(1, '{"type":"uncertain","operationId":1}', "uncertain");
      return unchanged;
  }
});

const nodeOf = (fx: Fixture, id: string) => ({
  id,
  projectId: fx.projectId,
  sessionId: fx.sessionId,
  run: fx.run,
  ok: true,
});

testAgent()("criterion-linked Goal completion", (it) => {
  it.effect("stages a running recorder and requires settled receipts before completing", () =>
    Effect.gen(function* () {
      const fx = yield* fixture("native");
      const workflows = yield* Workflows;
      yield* sqlRun("UPDATE chat_runs SET status = 'running' WHERE run_id = ?", fx.run);
      yield* sqlRun(
        `INSERT INTO owner_rpc_operations
        (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
        VALUES (?, '{}', 1, '{}', 1, '{"type":"pending","operationId":1}', 'pending')`,
        fx.run,
      );
      const staged = yield* workflows.updateProgress(fx.sessionId, fx.complete, fx.run);
      expect(staged.goal?.status).toBe("active");
      expect(staged.goal?.completion).toBeUndefined();
      expect(staged.goal?.completionRequest?.recorderRunId).toBe(fx.run);
      yield* workflows.finishRun(fx.sessionId, "execute");
      const pending = yield* workflows.finishRun(fx.sessionId, "verify");
      expect(pending.goal?.completion).toBeUndefined();
      yield* sqlRun("UPDATE chat_runs SET status = 'completed' WHERE run_id = ?", fx.run);
      yield* sqlRun(
        "UPDATE owner_rpc_operations SET status = 'succeeded' WHERE run_id = ?",
        fx.run,
      );
      const settled = yield* workflows.finishRun(fx.sessionId, "verify");
      expect(settled.goal?.status).toBe("completed");
      expect(settled.goal?.completion?.runs[0]?.durableExecutionId).toEqual(expect.any(String));
    }),
  );

  it.effect("WorkflowTools binds the recorder separately from untrusted input", () =>
    Effect.gen(function* () {
      const fx = yield* fixture("native");
      const tool = (yield* inRun(
        (yield* WorkflowTools).forSession(fx.sessionId, "execute", fx.run),
      )).find((item) => item.name === "update_workflow_progress");
      if (!isTruthy(tool?.execute)) return yield* Effect.die("Missing progress tool");
      const execute = tool.execute;
      const result = yield* Effect.tryPromise({
        try: () => Promise.resolve(execute({ ...fx.complete, recorderRunId: "spoofed" })),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      expect(result).toMatchObject({ goal: { completion: { recorderRunId: fx.run } } });
    }),
  );

  it.effect.each(refusals)("rejects completion with %s without writing it", (failure) =>
    Effect.gen(function* () {
      const fx = yield* fixture("native");
      const { input, recorder } = yield* breakProof(fx, failure);
      yield* refused(fx, input, recorder);
    }),
  );

  it.effect("registration alone and finishRun never prove outcomes", () =>
    Effect.gen(function* () {
      const fx = yield* fixture("native");
      const workflows = yield* Workflows;
      yield* refused(fx, noMappings);
      yield* workflows.updateProgress(fx.sessionId, verifiedProgress);
      yield* workflows.finishRun(fx.sessionId, "execute");
      const state = yield* workflows.finishRun(fx.sessionId, "verify");
      expect(state.goal?.status).toBe("active");
      expect(state.goal?.completion).toBeUndefined();
    }),
  );

  it.effect(
    "old Plan binding is rejected after replan and new Goal version clears completion",
    () =>
      Effect.gen(function* () {
        const fx = yield* fixture("native");
        const workflows = yield* Workflows;
        yield* workflows.updatePlan(fx.sessionId, plan);
        yield* workflows.setPhase(fx.sessionId, "execute");
        yield* refused(fx, fx.complete);
        yield* workflows.updateGoal(fx.sessionId, goal);
        yield* refused(fx, fx.complete);
      }),
  );

  it.effect("contradictory frozen snapshot is refused", () =>
    Effect.gen(function* () {
      const fx = yield* fixture("native");
      yield* (yield* Workflows).updateProgress(fx.sessionId, fx.complete, fx.run);
      yield* refused(fx, { ...fx.complete, criterionMappings: [fx.mapping(1), fx.mapping(0)] });
    }),
  );

  it.effect("legacy/unregistered compatibility and cancellation do not require mappings", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const legacy = yield* fixture("legacy");
      const state = yield* workflows.updateProgress(legacy.sessionId, noMappings);
      expect(state.goal?.status).toBe("completed");
      expect(state.goal?.completion).toBeUndefined();
      const native = yield* fixture("native");
      const cancelled = yield* workflows.controlGoal(native.sessionId, "stop");
      expect(cancelled.goal?.status).toBe("failed");
      expect(cancelled.goal?.completion).toBeUndefined();
    }),
  );
});

// Reopening replaces the agent behind every service, so this test owns its agent.
testAgent()("criterion-linked Goal completion across reopen", (it) => {
  it.effect(
    "atomic completion survives reopen, exact retry, and Goal revisions preserve immutable history",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const fx = yield* fixture("native");
        const workflows = yield* Workflows;
        const state = yield* workflows.updateProgress(fx.sessionId, fx.complete, fx.run);
        expect(state.goal?.status).toBe("completed");
        expect(state.goal?.completion).toMatchObject({
          goalInstanceId: fx.goalId,
          goalVersion: 1,
          planVersion: 1,
          projectId: fx.projectId,
          recorderRunId: fx.run,
          sourceGeneration: fx.source,
          nativeRegistration: { artifactHash: "a".repeat(64) },
          runs: [
            {
              runId: fx.run,
              dispatchGeneration: "dispatch",
              durableExecutionId: expect.any(String),
            },
          ],
        });
        const retry = yield* workflows.updateProgress(fx.sessionId, fx.complete, fx.run);
        expect(retry.goal?.completion).toEqual(state.goal?.completion);
        yield* env.reopen;
        const reopened = yield* env.use(
          Effect.gen(function* () {
            const workflows = yield* Workflows;
            const restored = (yield* workflows.get(fx.sessionId)).goal?.completion;
            yield* workflows.updateGoal(fx.sessionId, { ...goal, statement: "Revised" });
            const revised = (yield* workflows.get(fx.sessionId)).goal?.completion;
            const history = yield* sqlGet(
              `SELECT state_json FROM workflow_state_revisions WHERE session_id = ?
                AND json_extract(state_json, '$.goal.status') = 'completed' ORDER BY id LIMIT 1`,
              fx.sessionId,
            );
            const completed = yield* Schema.decodeEffect(Schema.fromJsonString(WorkflowState))(
              String(history?.state_json),
            );
            return { restored, revised, history: completed.goal?.completion };
          }),
        );
        expect(reopened.restored).toEqual(state.goal?.completion);
        expect(reopened.revised).toBeUndefined();
        expect(reopened.history).toEqual(state.goal?.completion);
      }),
  );
});
