import { Effect, Result } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { WorkflowTools } from "../src/workflow/tools.ts";
import { Workflows, type UpdateWorkflowProgress } from "../src/workflow/workflow.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { testRuntime } from "./support/runtime.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";

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

async function fixture(native = true) {
  const ctx = await testRuntime();
  const workflows = await ctx.runtime.runPromise(Workflows);
  const db = await ctx.runtime.runPromise(Database);
  await ctx.runtime.runPromise(
    Effect.gen(function* () {
      yield* workflows.updateGoal(ctx.session.id, goal);
      yield* workflows.updatePlan(ctx.session.id, plan);
      yield* workflows.setPhase(ctx.session.id, "execute");
    }),
  );
  const id = await ctx.runtime.runPromise(workflows.goalInstanceId(ctx.session.id));
  if (native)
    db.sqlite
      .prepare("INSERT INTO workflow_goal_native_artifacts VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, "file:///owner/native.mjs", "a".repeat(64), "native-v1", "b".repeat(64), "now");
  if (native)
    db.sqlite
      .prepare("INSERT INTO workflow_goal_worker_generations VALUES (?, ?, ?, ?, ?)")
      .run(id, "source", "c".repeat(64), "file:///owner/worker.mjs", "now");
  const revision = db.sqlite
    .prepare("SELECT max(id) AS id FROM workflow_state_revisions WHERE session_id = ?")
    .get(ctx.session.id)!.id;
  expect(workflowRunBindings(db).bind(ctx.session.id, "run", Number(revision)).status).toBe(
    "bound",
  );
  db.sqlite
    .prepare(
      "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'completed', 1)",
    )
    .run("run", ctx.session.id);
  db.sqlite
    .prepare("INSERT INTO workflow_worker_dispatches VALUES (?, ?, ?)")
    .run("run", "dispatch", "now");
  db.sqlite
    .prepare(`INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
    VALUES ('proof', ?, ?, 'run', 'tool_result', 'Tests passed', '{"ok":true}', 'now')`)
    .run(ctx.project.id, ctx.session.id);
  return { ...ctx, workflows, db, id };
}

async function refusal(
  ctx: Awaited<ReturnType<typeof fixture>>,
  input: UpdateWorkflowProgress,
  recorder = "run",
) {
  const before = await ctx.runtime.runPromise(ctx.workflows.get(ctx.session.id));
  const result = await ctx.runtime.runPromise(
    Effect.result(ctx.workflows.updateProgress(ctx.session.id, input, recorder)),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(await ctx.runtime.runPromise(ctx.workflows.get(ctx.session.id))).toEqual(before);
}

describe("criterion-linked Goal completion", () => {
  test("WorkflowTools binds the recorder separately from untrusted input", async () => {
    const ctx = await fixture();
    const tools = await ctx.runtime.runPromise(WorkflowTools);
    const tool = tools
      .forSession(ctx.session.id, "execute", "run")
      .find((item) => item.name === "update_workflow_progress");
    if (!tool?.execute) throw new Error("Missing progress tool");
    const result = await tool.execute({ ...complete, recorderRunId: "spoofed" });
    expect(result).toMatchObject({ goal: { completion: { recorderRunId: "run" } } });
  });
  test.each(["session", "project", "missing node", "failed result", "interrupted run"])(
    "rejects %s evidence ownership or success mismatch",
    async (failure) => {
      const ctx = await fixture();
      const otherProject = await ctx.runtime.runPromise(
        Effect.flatMap(Projects, (service) => service.add(ctx.home)),
      );
      const otherSession = await ctx.runtime.runPromise(
        Effect.flatMap(Sessions, (service) => service.create(ctx.project.id)),
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
          VALUES ('bad', ?, ?, 'run', 'tool_result', 'Check result', ?, 'now')`)
          .run(
            failure === "project" ? otherProject.id : ctx.project.id,
            failure === "session" ? otherSession.id : ctx.session.id,
            JSON.stringify({ ok: failure !== "failed result" }),
          );
      }
      await refusal(ctx, {
        ...complete,
        criterionMappings: [mapping(0), { ...mapping(1), evidenceNodeIds: [node] }],
      });
    },
  );

  test("atomic completion survives reopen, exact retry, and Goal revisions preserve immutable history", async () => {
    const ctx = await fixture();
    const state = await ctx.runtime.runPromise(
      ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
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
      runs: [{ runId: "run", dispatchGeneration: "dispatch" }],
    });
    const retry = await ctx.runtime.runPromise(
      ctx.workflows.updateProgress(ctx.session.id, complete, "run"),
    );
    expect(retry.goal?.completion).toEqual(state.goal?.completion);
    const reopened = await ctx.reopen();
    const workflows = await reopened.runPromise(Workflows);
    expect((await reopened.runPromise(workflows.get(ctx.session.id))).goal?.completion).toEqual(
      state.goal?.completion,
    );
    await reopened.runPromise(
      workflows.updateGoal(ctx.session.id, { ...goal, statement: "Revised" }),
    );
    expect(
      (await reopened.runPromise(workflows.get(ctx.session.id))).goal?.completion,
    ).toBeUndefined();
    const db = await reopened.runPromise(Database);
    const history = db.sqlite
      .prepare(`SELECT state_json FROM workflow_state_revisions WHERE session_id = ?
      AND json_extract(state_json, '$.goal.status') = 'completed' ORDER BY id LIMIT 1`)
      .get(ctx.session.id);
    expect(JSON.parse(String(history?.state_json)).goal.completion).toEqual(state.goal?.completion);
  });

  test.each([
    "missing",
    "incomplete",
    "foreign",
    "stale text",
    "stale acceptance",
    "wrong recorder",
    "empty proof",
    "wrong run",
  ])("rejects %s without writing completion", async (failure) => {
    const ctx = await fixture();
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
            VALUES ('foreign', ?, ?, 'other', 'tool_result', 'passed', '{"ok":true}', 'now')`)
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
        input = { ...complete, criterionMappings: [mapping(0), { ...mapping(1), runId: "other" }] };
        break;
    }
    await refusal(ctx, input, recorder);
  });

  test("registration alone and finishRun never prove outcomes", async () => {
    const ctx = await fixture();
    await refusal(ctx, noMappings);
    await ctx.runtime.runPromise(ctx.workflows.updateProgress(ctx.session.id, verifiedProgress));
    await ctx.runtime.runPromise(ctx.workflows.finishRun(ctx.session.id, "execute"));
    const state = await ctx.runtime.runPromise(ctx.workflows.finishRun(ctx.session.id, "verify"));
    expect(state.goal?.status).toBe("active");
    expect(state.goal?.completion).toBeUndefined();
  });

  test("old Plan binding is rejected after replan and new Goal version clears completion", async () => {
    const ctx = await fixture();
    await ctx.runtime.runPromise(ctx.workflows.updatePlan(ctx.session.id, plan));
    await ctx.runtime.runPromise(ctx.workflows.setPhase(ctx.session.id, "execute"));
    await refusal(ctx, complete);
    await ctx.runtime.runPromise(ctx.workflows.updateGoal(ctx.session.id, goal));
    await refusal(ctx, complete);
  });

  test("contradictory frozen snapshot is refused", async () => {
    const ctx = await fixture();
    await ctx.runtime.runPromise(ctx.workflows.updateProgress(ctx.session.id, complete, "run"));
    await refusal(ctx, { ...complete, criterionMappings: [mapping(1), mapping(0)] });
  });

  test("legacy/unregistered compatibility and cancellation do not require mappings", async () => {
    const ctx = await fixture(false);
    const state = await ctx.runtime.runPromise(
      ctx.workflows.updateProgress(ctx.session.id, noMappings),
    );
    expect(state.goal?.status).toBe("completed");
    expect(state.goal?.completion).toBeUndefined();
    const native = await fixture();
    const cancelled = await native.runtime.runPromise(
      native.workflows.controlGoal(native.session.id, "stop"),
    );
    expect(cancelled.goal?.status).toBe("failed");
    expect(cancelled.goal?.completion).toBeUndefined();
  });
});
