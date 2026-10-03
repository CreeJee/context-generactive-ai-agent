import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { WorkflowExecution } from "../src/workflow/execution.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import type { ScriptedTurn } from "../src/testing/scripted-adapter.ts";
import type { JsonValue as Json } from "../src/json.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "Finish the approved work",
  outcomes: ["Implemented and verified"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const plan = {
  summary: "Implement then verify",
  status: "ready" as const,
  risks: [],
  openQuestions: [],
  steps: [
    {
      id: "p1",
      title: "Implement",
      description: "Perform the work",
      dependsOn: [],
      acceptanceCriteria: ["Check passes"],
      ruleRefs: [],
    },
  ],
};
const call = (id: string, name: string, input: Json): ScriptedTurn => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(input) }],
});
const completed = (evidence = "Implementation test passed") => ({
  steps: [{ id: "p1", status: "completed", evidence: [evidence] }],
  detail: "Implemented",
});
const passed = {
  verification: {
    status: "passed",
    summary: "Criteria checked",
    evidence: ["Verification passed"],
  },
  detail: "Verified",
};

async function setup(turns: readonly ScriptedTurn[]) {
  const context = await testRuntime({
    testProvider: {
      responder: ({ index }) => {
        const turn = turns[index];
        if (!turn) throw new Error(`Unexpected model iteration ${index}`);
        return turn;
      },
    },
  });
  await context.provider!.select(context.runtime);
  const workflows = await context.runtime.runPromise(Workflows);
  await context.runtime.runPromise(
    Effect.gen(function* () {
      yield* workflows.updateGoal(context.session.id, goal);
      yield* workflows.updatePlan(context.session.id, plan);
      yield* workflows.setPhase(context.session.id, "execute");
    }),
  );
  const agent = await context.runtime.runPromise(AgentChat);
  const execution = await context.runtime.runPromise(WorkflowExecution);
  const request = (runId = "initial-run") =>
    new Request("http://local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: context.session.id,
        runId,
        tools: [],
        context: [],
        messages: [{ id: `${runId}-user`, role: "user", content: "Execute the approved Plan" }],
      }),
    });
  const run = async (runId?: string) => {
    const response = await context.runtime.runPromise(
      agent.handle(request(runId), context.session.id),
    );
    expect(response.status).toBe(200);
    return response.text();
  };
  return {
    ...context,
    agent,
    workflows,
    execution,
    run,
    readExecution: () => context.runtime.runPromise(execution.get(context.session.id)),
  };
}

test("continues a promise-only turn without a browser and verifies the completed Plan", async () => {
  const context = await setup([
    { text: "I will review this next." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implementation checked." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
  expect(context.provider!.adapter.invocations).toHaveLength(5);
  expect(new Set(context.provider!.adapter.invocations.map((turn) => turn.runId)).size).toBe(3);
  expect(context.provider!.adapter.invocations[1]?.systemPrompts.join("\n")).toContain(
    "automatic continuation of the already approved Plan",
  );
  expect(context.provider!.adapter.invocations[3]?.systemPrompts.join("\n")).toContain(
    "Workflow phase: verify",
  );
  const nodes = await context.runtime.runPromise(Nodes);
  expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toHaveLength(1);
  expect(await context.readExecution()).toEqual({
    kind: "stopped",
    reason: "completed",
  });
});

test("stops after two turns without progress and persists the reason across reopen", async () => {
  const context = await setup([{ text: "I need to review." }, { text: "I will review next." }]);
  await context.run();
  await expect.poll(async () => (await context.readExecution()).kind).toBe("blocked");
  expect(await context.readExecution()).toMatchObject({ reason: "repeated_failure" });
  expect(context.provider!.adapter.invocations).toHaveLength(2);
  const reopened = await context.reopen();
  const execution = await reopened.runPromise(WorkflowExecution);
  await reopened.runPromise(AgentChat);
  expect(await reopened.runPromise(execution.get(context.session.id))).toMatchObject({
    kind: "blocked",
    reason: "repeated_failure",
  });
  expect(await reopened.runPromise(execution.readySessions())).not.toContain(context.session.id);
});

test("new evidence resets the consecutive no-progress limit even before a step completes", async () => {
  const context = await setup([
    { text: "Next I will inspect." },
    call("partial", "update_workflow_progress", {
      planEvidence: ["Read the current contract"],
      detail: "Investigated",
    }),
    { text: "Contract inspected." },
    { text: "Next I will check implementation." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implementation checked." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
  expect(context.provider!.adapter.invocations).toHaveLength(8);
});

test("a successful read investigation resets no-progress without a workflow progress call", async () => {
  const context = await setup([
    { text: "Next I will inspect the contract." },
    call("read-contract", "read_file", { path: "contract.txt" }),
    { text: "The contract is inspected." },
    { text: "Next I will implement." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implemented." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  writeFileSync(join(context.base, "project", "contract.txt"), "Acceptance contract\n");
  await context.run();
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
  expect(context.provider!.adapter.invocations).toHaveLength(8);
});

test("identical successful read results cannot keep automatic execution alive", async () => {
  const context = await setup([
    call("read-1", "read_file", { path: "contract.txt" }),
    { text: "Read the contract." },
    call("read-2", "read_file", { path: "contract.txt" }),
    { text: "Read it again." },
    call("read-3", "read_file", { path: "contract.txt" }),
    { text: "Read the same contract again." },
  ]);
  writeFileSync(join(context.base, "project", "contract.txt"), "Acceptance contract\n");
  await context.run();
  await expect.poll(async () => (await context.readExecution()).kind).toBe("blocked");
  expect(await context.readExecution()).toMatchObject({ reason: "repeated_failure" });
  expect(context.provider!.adapter.invocations).toHaveLength(6);
});

test("failed read investigations do not reset the no-progress limit", async () => {
  const context = await setup([
    call("missing-1", "read_file", { path: "missing-one.txt" }),
    { text: "The first file was missing." },
    call("missing-2", "read_file", { path: "missing-two.txt" }),
    { text: "The second file was missing." },
  ]);
  await context.run();
  await expect.poll(async () => (await context.readExecution()).kind).toBe("blocked");
  expect(context.provider!.adapter.invocations).toHaveLength(4);
});

test("successful file creation counts before any workflow step is completed", async () => {
  const context = await setup([
    { text: "Next I will implement." },
    call("write", "write_file", { path: "implementation.txt", content: "Implemented\n" }),
    { text: "File written." },
    { text: "Next I will check." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implemented." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
  expect(context.provider!.adapter.invocations).toHaveLength(8);
});

test("records a confirmed blocker instead of automatically continuing", async () => {
  const context = await setup([
    call("blocker", "record_workflow_blocker", {
      reason: "user_decision",
      detail: "Choose the deployment target",
      evidence: ["Two incompatible targets remain"],
    }),
    { text: "Which target should I use?" },
  ]);
  await context.run();
  expect(await context.readExecution()).toMatchObject({
    kind: "blocked",
    reason: "user_decision",
    detail: "Choose the deployment target",
  });
  expect(context.provider!.adapter.invocations).toHaveLength(2);
});

test("does not start another turn while a tool approval is pending", async () => {
  const context = await setup([
    call("shell", "run_shell", { command: "printf approved", reason: "Check the implementation" }),
  ]);
  await context.run();
  const response = await context.runtime.runPromise(context.agent.status(context.session.id, null));
  expect(await response.json()).toMatchObject({ lastRun: { status: "interrupted" } });
  expect(context.provider!.adapter.invocations).toHaveLength(1);
});

test("cancel stops a pending continuation before it starts", async () => {
  const context = await setup([{ text: "I will review." }]);
  await context.run();
  expect((await context.readExecution()).kind).toBe("ready");
  const response = await context.runtime.runPromise(context.agent.cancel(context.session.id, null));
  expect(response.status).toBe(200);
  expect(await context.readExecution()).toEqual({ kind: "stopped", reason: "user" });
  const reopened = await context.reopen();
  await reopened.runPromise(AgentChat);
  expect(
    await reopened.runPromise(
      Effect.flatMap(WorkflowExecution, (execution) => execution.readySessions()),
    ),
  ).toHaveLength(0);
  expect(context.provider!.adapter.invocations).toHaveLength(1);
});

test("a material Plan revision stops automatic execution for confirmation", async () => {
  const context = await setup([
    call("replan", "update_plan", { ...plan, summary: "Different acceptance criteria" }),
    { text: "Review the revised Plan." },
  ]);
  await context.run();
  expect((await context.runtime.runPromise(context.workflows.get(context.session.id))).phase).toBe(
    "plan",
  );
  expect(await context.readExecution()).toEqual({
    kind: "stopped",
    reason: "workflow_changed",
  });
  expect(context.provider!.adapter.invocations).toHaveLength(2);
});

test("repairs failed verification in Execute before trying Verify again", async () => {
  const context = await setup([
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implemented." },
    call("failed-check", "update_workflow_progress", {
      verification: {
        status: "failed",
        summary: "Regression found",
        evidence: ["Regression test failed"],
      },
      detail: "Repair needed",
    }),
    { text: "The regression needs repair." },
    call("repair", "update_workflow_progress", {
      ...completed("Regression fixed"),
      verification: { status: "not_run", summary: "Repair ready to check", evidence: [] },
    }),
    { text: "Repaired." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
  expect(context.provider!.adapter.invocations[4]?.systemPrompts.join("\n")).toContain(
    "Workflow phase: execute",
  );
  expect(context.provider!.adapter.invocations[6]?.systemPrompts.join("\n")).toContain(
    "Workflow phase: verify",
  );
});

test("a new user turn can resume execution after the no-progress limit", async () => {
  const context = await setup([
    { text: "I will review." },
    { text: "I will review next." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implemented." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  await expect.poll(async () => (await context.readExecution()).kind).toBe("blocked");
  await context.run("user-resume");
  await expect
    .poll(
      async () =>
        (await context.runtime.runPromise(context.workflows.get(context.session.id))).goal?.status,
    )
    .toBe("completed");
});

test("repeating the same evidence does not reset the no-progress limit", async () => {
  const partial = { planEvidence: ["Same check result"], detail: "Checked again" };
  const context = await setup([
    call("first", "update_workflow_progress", partial),
    { text: "Partial work." },
    call("second", "update_workflow_progress", partial),
    { text: "Same check." },
    call("third", "update_workflow_progress", partial),
    { text: "Same check again." },
  ]);
  await context.run();
  await expect.poll(async () => (await context.readExecution()).kind).toBe("blocked");
  expect(context.provider!.adapter.invocations).toHaveLength(6);
});

test("a failed model run does not automatically retry", async () => {
  const context = await setup([{ text: "I will check.", failAfterText: "provider failed" }]);
  await context.run();
  expect(await context.readExecution()).toEqual({ kind: "stopped", reason: "run_failed" });
  expect(context.provider!.adapter.invocations).toHaveLength(1);
});

test("reopens only a clean completed run with a persisted pending continuation", async () => {
  const context = await setup([
    { text: "I will review next." },
    call("implementation", "update_workflow_progress", completed()),
    { text: "Implemented." },
    call("verification", "update_workflow_progress", passed),
    { text: "Verified." },
  ]);
  await context.run();
  const reopened = await context.reopen();
  await reopened.runPromise(AgentChat);
  const workflows = await reopened.runPromise(Workflows);
  await expect
    .poll(async () => (await reopened.runPromise(workflows.get(context.session.id))).goal?.status)
    .toBe("completed");
});
