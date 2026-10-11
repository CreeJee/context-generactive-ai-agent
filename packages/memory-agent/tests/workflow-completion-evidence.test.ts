import { it } from "@effect/vitest";
import { isTruthy } from "../src/truthy.ts";
import { Cause, Effect, Result, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkflowTools } from "../src/workflow/tools.ts";
import { Workflows, WorkflowState, type UpdateWorkflowProgress } from "../src/workflow/workflow.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { GoalExecution, GoalExecutions } from "../src/workflow/goal-execution.ts";
import type { GoalExecutionPayload } from "../src/workflow/goal-execution-contracts.ts";
import { testRuntime } from "./support/runtime.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";

const sdkCall = Effect.fn("workflowCompletionTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

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
const mapping = (outcomeIndex: number) => ({
  outcomeIndex,
  outcomeText: goal.outcomes[outcomeIndex]!,
  stepId: "step",
  acceptanceIndex: 0,
  acceptanceText: "Actual verification",
  runId: "run",
  evidenceNodeIds: ["proof"],
});
const complete: UpdateWorkflowProgress = {
  goalStatus: "completed",
  planStatus: "completed",
  steps: [{ id: "step", status: "completed", evidence: ["proof"] }],
  goalEvidence: ["proof"],
  planEvidence: ["proof"],
  verification: { status: "passed", summary: "Focused check passed", evidence: ["proof"] },
  criterionMappings: [mapping(0), mapping(1)],
  detail: "Verified outcomes",
};

const noMappings = { ...complete };
delete noMappings.criterionMappings;
const verifiedProgress = { ...noMappings };
delete verifiedProgress.goalStatus;
delete verifiedProgress.planStatus;

const fixture = Effect.fn("workflowCompletionTest.fixture")(function* (native: boolean = true) {
  const ctx = yield* sdkCall(() => testRuntime());
  const workflows = yield* Effect.provideContext(Workflows, yield* ctx.runtime.contextEffect);
  const db = yield* Effect.provideContext(Database, yield* ctx.runtime.contextEffect);
  yield* Effect.provideContext(
    Effect.gen(function* () {
      yield* workflows.updateGoal(ctx.session.id, goal);
      yield* workflows.updatePlan(ctx.session.id, plan);
      yield* workflows.setPhase(ctx.session.id, "execute");
    }),
    yield* ctx.runtime.contextEffect,
  );
  const id = yield* Effect.provideContext(
    workflows.goalInstanceId(ctx.session.id),
    yield* ctx.runtime.contextEffect,
  );
  if (id === null) return yield* Effect.die("Expected Goal identity");
  if (native)
    db.sqlite
      .prepare("INSERT INTO workflow_goal_native_artifacts VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        id,
        "file:///owner/native.mjs",
        "a".repeat(64),
        "native-v1",
        "b".repeat(64),
        "2026-10-07T00:00:00.000Z",
      );
  if (native)
    db.sqlite
      .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
      .run(id, "source", "c".repeat(64), "file:///owner/worker.mjs", "2026-10-07T00:00:00.000Z");
  const revision = db.sqlite
    .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
    .get(ctx.session.id)!.id;
  if (native) {
    const goals = yield* Effect.provideContext(GoalExecutions, yield* ctx.runtime.contextEffect);
    const payload: GoalExecutionPayload = {
      _tag: "GoalExecutionPayload",
      identity: {
        owner: { ownerId: ctx.project.id, generation: "test-owner-generation" },
        sessionId: ctx.session.id,
        runId: "run",
        goalInstanceId: id,
        workflowRevisionId: Number(revision),
      },
    };
    const admitted = yield* Effect.provideContext(
      goals.admitAndStart(payload, () =>
        workflowRunBindings(db).bind(ctx.session.id, "run", Number(revision)),
      ),
      yield* ctx.runtime.contextEffect,
    );
    expect(admitted.type).toBe("admitted");
    yield* Effect.provideContext(goals.succeed(payload), yield* ctx.runtime.contextEffect);
    yield* Effect.provideContext(GoalExecution.execute(payload), yield* ctx.runtime.contextEffect);
  } else {
    expect(workflowRunBindings(db).bind(ctx.session.id, "run", Number(revision)).status).toBe(
      "bound",
    );
  }
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', 1)",
    )
    .run("run", ctx.session.id);
  db.sqlite
    .prepare("INSERT INTO workflow_worker_dispatches VALUES (?, ?, ?)")
    .run("run", "dispatch", "2026-10-07T00:00:00.000Z");
  db.sqlite
    .prepare(`INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
    VALUES ('proof', ?, ?, 'run', 'tool_result', 'Tests passed', '{"ok":true}', '2026-10-07T00:00:00.000Z')`)
    .run(ctx.project.id, ctx.session.id);
  return { ...ctx, workflows, db, id };
});

const refusal = Effect.fn("workflowCompletionTest.refusal")(function* (
  ctx: Effect.Success<ReturnType<typeof fixture>>,
  input: UpdateWorkflowProgress,
  recorder: string = "run",
) {
  const before = yield* Effect.provideContext(
    ctx.workflows.get(ctx.session.id),
    yield* ctx.runtime.contextEffect,
  );
  const result = yield* Effect.provideContext(
    Effect.result(ctx.workflows.updateProgress(ctx.session.id, input, recorder)),
    yield* ctx.runtime.contextEffect,
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(
    yield* Effect.provideContext(
      ctx.workflows.get(ctx.session.id),
      yield* ctx.runtime.contextEffect,
    ),
  ).toEqual(before);
});

describe("criterion-linked Goal completion", () => {
  it.live("stages a running recorder and requires settled receipts before completing", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      ctx.db.sqlite.prepare("UPDATE chat_runs SET status = 'running' WHERE run_id = 'run'").run();
      ctx.db.sqlite
        .prepare(`INSERT INTO owner_rpc_operations
        (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
        VALUES ('run', '{}', 1, '{}', 1, '{"type":"pending","operationId":1}', 'pending')`)
        .run();
      const services = yield* ctx.runtime.contextEffect;
      const staged = yield* Effect.provideContext(
        ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
        services,
      );
      expect(staged.goal?.status).toBe("active");
      expect(staged.goal?.completion).toBeUndefined();
      expect(staged.goal?.completionRequest?.recorderRunId).toBe("run");
      yield* Effect.provideContext(ctx.workflows.finishRun(ctx.session.id, "execute"), services);
      const pending = yield* Effect.provideContext(
        ctx.workflows.finishRun(ctx.session.id, "verify"),
        services,
      );
      expect(pending.goal?.completion).toBeUndefined();
      ctx.db.sqlite.prepare("UPDATE chat_runs SET status = 'completed' WHERE run_id = 'run'").run();
      ctx.db.sqlite
        .prepare("UPDATE owner_rpc_operations SET status = 'succeeded' WHERE run_id = 'run'")
        .run();
      const settled = yield* Effect.provideContext(
        ctx.workflows.finishRun(ctx.session.id, "verify"),
        services,
      );
      expect(settled.goal?.status).toBe("completed");
      expect(settled.goal?.completion?.runs[0]?.durableExecutionId).toEqual(expect.any(String));
    }),
  );
  it.live("WorkflowTools binds the recorder separately from untrusted input", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      const tools = yield* Effect.provideContext(WorkflowTools, yield* ctx.runtime.contextEffect);
      const tool = tools
        .forSession(ctx.session.id, "execute", "run")
        .find((item) => item.name === "update_workflow_progress");
      if (!isTruthy(tool?.execute)) throw new Error("Missing progress tool");
      const execute = tool.execute;
      const result = yield* sdkCall(() => execute({ ...complete, recorderRunId: "spoofed" }));
      expect(result).toMatchObject({ goal: { completion: { recorderRunId: "run" } } });
    }),
  );
  it.live.each(["session", "project", "missing node", "failed result", "interrupted run"])(
    "rejects %s evidence ownership or success mismatch",
    (failure) =>
      Effect.gen(function* () {
        const ctx = yield* fixture();
        const otherProject = yield* Effect.provideContext(
          Effect.flatMap(Projects, (service) => service.add(ctx.home)),
          yield* ctx.runtime.contextEffect,
        );
        const otherSession = yield* Effect.provideContext(
          Effect.flatMap(Sessions, (service) => service.create(ctx.project.id)),
          yield* ctx.runtime.contextEffect,
        );
        let node = "bad";
        if (failure === "interrupted run") {
          ctx.db.sqlite
            .prepare("UPDATE chat_runs SET status = 'interrupted' WHERE run_id = 'run'")
            .run();
          node = "proof";
        } else if (failure !== "missing node") {
          ctx.db.sqlite
            .prepare(`INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
          VALUES ('bad', ?, ?, 'run', 'tool_result', 'Check result', ?, '2026-10-07T00:00:00.000Z')`)
            .run(
              failure === "project" ? otherProject.id : ctx.project.id,
              failure === "session" ? otherSession.id : ctx.session.id,
              yield* Schema.encodeEffect(
                Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean })),
              )({ ok: failure !== "failed result" }),
            );
        }
        yield* refusal(ctx, {
          ...complete,
          criterionMappings: [mapping(0), { ...mapping(1), evidenceNodeIds: [node] }],
        });
      }),
  );

  it.live(
    "atomic completion survives reopen, exact retry, and Goal revisions preserve immutable history",
    () =>
      Effect.gen(function* () {
        const ctx = yield* fixture();
        const state = yield* Effect.provideContext(
          ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
          yield* ctx.runtime.contextEffect,
        );
        expect(state.goal?.status).toBe("completed");
        expect(state.goal?.completion).toMatchObject({
          goalInstanceId: ctx.id,
          goalVersion: 1,
          planVersion: 1,
          projectId: ctx.project.id,
          recorderRunId: "run",
          sourceGeneration: "source",
          nativeRegistration: { artifactHash: "a".repeat(64) },
          runs: [
            {
              runId: "run",
              dispatchGeneration: "dispatch",
              durableExecutionId: expect.any(String),
            },
          ],
        });
        const retry = yield* Effect.provideContext(
          ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
          yield* ctx.runtime.contextEffect,
        );
        expect(retry.goal?.completion).toEqual(state.goal?.completion);
        const reopened = yield* sdkCall(() => ctx.reopen());
        const workflows = yield* Effect.provideContext(Workflows, yield* reopened.contextEffect);
        expect(
          (yield* Effect.provideContext(
            workflows.get(ctx.session.id),
            yield* reopened.contextEffect,
          )).goal?.completion,
        ).toEqual(state.goal?.completion);
        yield* Effect.provideContext(
          workflows.updateGoal(ctx.session.id, { ...goal, statement: "Revised" }),
          yield* reopened.contextEffect,
        );
        expect(
          (yield* Effect.provideContext(
            workflows.get(ctx.session.id),
            yield* reopened.contextEffect,
          )).goal?.completion,
        ).toBeUndefined();
        const db = yield* Effect.provideContext(Database, yield* reopened.contextEffect);
        const history = db.sqlite
          .prepare(`SELECT state_json FROM workflow_state_revisions WHERE session_id = ?
      AND json_extract(state_json, '$.goal.status') = 'completed' ORDER BY id LIMIT 1`)
          .get(ctx.session.id);
        expect(
          (yield* Schema.decodeEffect(Schema.fromJsonString(WorkflowState))(
            String(history?.state_json),
          )).goal?.completion,
        ).toEqual(state.goal?.completion);
      }),
  );

  it.live.each([
    "missing",
    "incomplete",
    "foreign",
    "stale text",
    "stale acceptance",
    "wrong recorder",
    "empty proof",
    "wrong run",
  ])("rejects %s without writing completion", (failure) =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      let input = complete;
      let recorder = "run";
      switch (failure) {
        case "missing":
          input = noMappings;
          break;
        case "incomplete":
          input = { ...complete, criterionMappings: [mapping(0)] };
          break;
        case "foreign": {
          ctx.db.sqlite
            .prepare(`INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
            VALUES ('foreign', ?, ?, 'other', 'tool_result', 'passed', '{"ok":true}', '2026-10-07T00:00:00.000Z')`)
            .run(ctx.project.id, ctx.session.id);
          input = {
            ...complete,
            criterionMappings: [mapping(0), { ...mapping(1), evidenceNodeIds: ["foreign"] }],
          };
          break;
        }
        case "stale text":
          input = {
            ...complete,
            criterionMappings: [mapping(0), { ...mapping(1), outcomeText: "old" }],
          };
          break;
        case "stale acceptance":
          input = {
            ...complete,
            criterionMappings: [mapping(0), { ...mapping(1), acceptanceText: "old" }],
          };
          break;
        case "wrong recorder":
          recorder = "foreign";
          break;
        case "empty proof":
          input = {
            ...complete,
            criterionMappings: [mapping(0), { ...mapping(1), evidenceNodeIds: [] }],
          };
          break;
        case "wrong run":
          input = {
            ...complete,
            criterionMappings: [mapping(0), { ...mapping(1), runId: "other" }],
          };
          break;
      }
      yield* refusal(ctx, input, recorder);
    }),
  );

  it.live.each([
    "missing execution",
    "suspended execution",
    "failed execution",
    "missing dispatch",
    "pending operation",
    "uncertain effect",
  ])("rejects source-bound completion with %s", (failure) =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      switch (failure) {
        case "missing execution":
          ctx.db.sqlite.prepare("DELETE FROM owner_workflow_executions").run();
          break;
        case "suspended execution":
          ctx.db.sqlite
            .prepare(
              "UPDATE owner_workflow_executions SET status = 'suspended', result_json = '{\"_tag\":\"Suspended\"}'",
            )
            .run();
          break;
        case "failed execution":
          ctx.db.sqlite
            .prepare(
              'UPDATE owner_workflow_executions SET status = \'completed\', result_json = \'{"_tag":"Complete","exit":{"_tag":"Failure"}}\'',
            )
            .run();
          break;
        case "missing dispatch":
          ctx.db.sqlite
            .prepare("DELETE FROM workflow_worker_dispatches WHERE run_id = 'run'")
            .run();
          break;
        case "pending operation":
        case "uncertain effect": {
          const uncertain = failure === "uncertain effect";
          ctx.db.sqlite
            .prepare(
              `INSERT INTO owner_rpc_operations
               (run_id, run_key, operation_id, fingerprint, side_effect, reply_json, status)
               VALUES ('run', '{}', 1, '{}', ?, ?, ?)`,
            )
            .run(
              uncertain ? 1 : 0,
              uncertain
                ? '{"type":"uncertain","operationId":1}'
                : '{"type":"pending","operationId":1}',
              uncertain ? "uncertain" : "pending",
            );
          break;
        }
      }
      yield* refusal(ctx, complete);
    }),
  );

  it.live("registration alone and finishRun never prove outcomes", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      yield* refusal(ctx, noMappings);
      yield* Effect.provideContext(
        ctx.workflows.updateProgress(ctx.session.id, verifiedProgress),
        yield* ctx.runtime.contextEffect,
      );
      yield* Effect.provideContext(
        ctx.workflows.finishRun(ctx.session.id, "execute"),
        yield* ctx.runtime.contextEffect,
      );
      const state = yield* Effect.provideContext(
        ctx.workflows.finishRun(ctx.session.id, "verify"),
        yield* ctx.runtime.contextEffect,
      );
      expect(state.goal?.status).toBe("active");
      expect(state.goal?.completion).toBeUndefined();
    }),
  );

  it.live("old Plan binding is rejected after replan and new Goal version clears completion", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      yield* Effect.provideContext(
        ctx.workflows.updatePlan(ctx.session.id, plan),
        yield* ctx.runtime.contextEffect,
      );
      yield* Effect.provideContext(
        ctx.workflows.setPhase(ctx.session.id, "execute"),
        yield* ctx.runtime.contextEffect,
      );
      yield* refusal(ctx, complete);
      yield* Effect.provideContext(
        ctx.workflows.updateGoal(ctx.session.id, goal),
        yield* ctx.runtime.contextEffect,
      );
      yield* refusal(ctx, complete);
    }),
  );

  it.live("contradictory frozen snapshot is refused", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture();
      yield* Effect.provideContext(
        ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
        yield* ctx.runtime.contextEffect,
      );
      yield* refusal(ctx, { ...complete, criterionMappings: [mapping(1), mapping(0)] });
    }),
  );

  it.live("legacy/unregistered compatibility and cancellation do not require mappings", () =>
    Effect.gen(function* () {
      const ctx = yield* fixture(false);
      const state = yield* Effect.provideContext(
        ctx.workflows.updateProgress(ctx.session.id, noMappings),
        yield* ctx.runtime.contextEffect,
      );
      expect(state.goal?.status).toBe("completed");
      expect(state.goal?.completion).toBeUndefined();
      const native = yield* fixture();
      const cancelled = yield* Effect.provideContext(
        native.workflows.controlGoal(native.session.id, "stop"),
        yield* native.runtime.contextEffect,
      );
      expect(cancelled.goal?.status).toBe("failed");
      expect(cancelled.goal?.completion).toBeUndefined();
    }),
  );
});
