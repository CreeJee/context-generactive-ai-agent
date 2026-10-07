import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { Array as EffectArray } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Cause, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { expect } from "vite-plus/test";
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

const setup = Effect.fn("WorkflowExecutionTest.setup")(function* (turns: readonly ScriptedTurn[]) {
  const context = yield* sdkCall(() =>
    testRuntime({
      testProvider: {
        responder: ({ index }) => {
          const turn = turns[index];
          if (!isTruthy(turn)) throw new Error(`Unexpected model iteration ${index}`);
          return turn;
        },
      },
    }),
  );
  yield* sdkCall(() => context.provider!.select(context.runtime));
  const workflows = yield* Effect.provideContext(Workflows, yield* context.runtime.contextEffect);
  yield* Effect.provideContext(
    Effect.gen(function* () {
      yield* workflows.updateGoal(context.session.id, goal);
      yield* workflows.updatePlan(context.session.id, plan);
      yield* workflows.setPhase(context.session.id, "execute");
    }),
    yield* context.runtime.contextEffect,
  );
  const agent = yield* Effect.provideContext(AgentChat, yield* context.runtime.contextEffect);
  const execution = yield* Effect.provideContext(
    WorkflowExecution,
    yield* context.runtime.contextEffect,
  );
  const request = Effect.fn("WorkflowExecutionTest.request")(function* (
    runId: string = "initial-run",
  ) {
    return new Request("http://local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        threadId: context.session.id,
        runId,
        tools: [],
        context: [],
        messages: [{ id: `${runId}-user`, role: "user", content: "Execute the approved Plan" }],
      }),
    });
  });
  const run = Effect.fn("WorkflowExecutionTest.run")(function* (runId?: string) {
    const input = yield* request(runId);
    const response = yield* Effect.provideContext(
      agent.handle(input, context.session.id),
      yield* context.runtime.contextEffect,
    );
    expect(response.status).toBe(200);
    return yield* sdkCall(() => response.text());
  });
  return {
    ...context,
    agent,
    workflows,
    execution,
    run,
    readExecution: Effect.fn("WorkflowExecutionTest.readExecution")(function* () {
      return yield* Effect.provideContext(
        execution.get(context.session.id),
        yield* context.runtime.contextEffect,
      );
    }),
  };
});

it.live("continues a promise-only turn without a browser and verifies the completed Plan", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "I will review this next." },
        call("implementation", "update_workflow_progress", completed()),
        { text: "Implementation checked." },
        call("verification", "update_workflow_progress", passed),
        { text: "Verified." },
      ]);
      yield* context.run();
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
      expect(context.provider!.adapter.invocations).toHaveLength(5);
      expect(
        EffectArray.dedupe(context.provider!.adapter.invocations.map((turn) => turn.runId)).length,
      ).toBe(3);
      expect(context.provider!.adapter.invocations[1]?.systemPrompts.join("\n")).toContain(
        "automatic continuation of the already approved Plan",
      );
      expect(context.provider!.adapter.invocations[3]?.systemPrompts.join("\n")).toContain(
        "Workflow phase: verify",
      );
      const nodes = yield* Effect.provideContext(Nodes, yield* context.runtime.contextEffect);
      expect(nodes.session(context.session.id).filter((node) => node.kind === "user")).toHaveLength(
        1,
      );
      expect(yield* context.readExecution()).toEqual({
        kind: "stopped",
        reason: "completed",
      });
    }),
  ),
);

it.live("stops after two turns without progress and persists the reason across reopen", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "I need to review." },
        { text: "I will review next." },
      ]);
      yield* context.run();
      yield* waitFor(context.readExecution().pipe(Effect.map((state) => state.kind)), "blocked");
      expect(yield* context.readExecution()).toMatchObject({ reason: "repeated_failure" });
      expect(context.provider!.adapter.invocations).toHaveLength(2);
      const reopened = yield* sdkCall(() => context.reopen());
      const execution = yield* Effect.provideContext(
        WorkflowExecution,
        yield* reopened.contextEffect,
      );
      yield* Effect.provideContext(AgentChat, yield* reopened.contextEffect);
      expect(
        yield* Effect.provideContext(
          execution.get(context.session.id),
          yield* reopened.contextEffect,
        ),
      ).toMatchObject({
        kind: "blocked",
        reason: "repeated_failure",
      });
      expect(
        yield* Effect.provideContext(execution.readySessions(), yield* reopened.contextEffect),
      ).not.toContain(context.session.id);
    }),
  ),
);

it.live("new evidence resets the consecutive no-progress limit even before a step completes", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
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
      yield* context.run();
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
      expect(context.provider!.adapter.invocations).toHaveLength(8);
    }),
  ),
);

it.live("a successful read investigation resets no-progress without a workflow progress call", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "Next I will inspect the contract." },
        call("read-contract", "read_file", { path: "contract.txt" }),
        { text: "The contract is inspected." },
        { text: "Next I will implement." },
        call("implementation", "update_workflow_progress", completed()),
        { text: "Implemented." },
        call("verification", "update_workflow_progress", passed),
        { text: "Verified." },
      ]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(context.base, "project", "contract.txt"),
        "Acceptance contract\n",
      );
      yield* context.run();
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
      expect(context.provider!.adapter.invocations).toHaveLength(8);
    }),
  ),
);

it.live("identical successful read results cannot keep automatic execution alive", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        call("read-1", "read_file", { path: "contract.txt" }),
        { text: "Read the contract." },
        call("read-2", "read_file", { path: "contract.txt" }),
        { text: "Read it again." },
        call("read-3", "read_file", { path: "contract.txt" }),
        { text: "Read the same contract again." },
      ]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(context.base, "project", "contract.txt"),
        "Acceptance contract\n",
      );
      yield* context.run();
      yield* waitFor(context.readExecution().pipe(Effect.map((state) => state.kind)), "blocked");
      expect(yield* context.readExecution()).toMatchObject({ reason: "repeated_failure" });
      expect(context.provider!.adapter.invocations).toHaveLength(6);
    }),
  ),
);

it.live("failed read investigations do not reset the no-progress limit", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        call("missing-1", "read_file", { path: "missing-one.txt" }),
        { text: "The first file was missing." },
        call("missing-2", "read_file", { path: "missing-two.txt" }),
        { text: "The second file was missing." },
      ]);
      yield* context.run();
      yield* waitFor(context.readExecution().pipe(Effect.map((state) => state.kind)), "blocked");
      expect(context.provider!.adapter.invocations).toHaveLength(4);
    }),
  ),
);

it.live("successful file creation counts before any workflow step is completed", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "Next I will implement." },
        call("write", "write_file", { path: "implementation.txt", content: "Implemented\n" }),
        { text: "File written." },
        { text: "Next I will check." },
        call("implementation", "update_workflow_progress", completed()),
        { text: "Implemented." },
        call("verification", "update_workflow_progress", passed),
        { text: "Verified." },
      ]);
      yield* context.run();
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
      expect(context.provider!.adapter.invocations).toHaveLength(8);
    }),
  ),
);

it.live("records a confirmed blocker instead of automatically continuing", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        call("blocker", "record_workflow_blocker", {
          reason: "user_decision",
          detail: "Choose the deployment target",
          evidence: ["Two incompatible targets remain"],
        }),
        { text: "Which target should I use?" },
      ]);
      yield* context.run();
      expect(yield* context.readExecution()).toMatchObject({
        kind: "blocked",
        reason: "user_decision",
        detail: "Choose the deployment target",
      });
      expect(context.provider!.adapter.invocations).toHaveLength(2);
    }),
  ),
);

it.live("does not start another turn while a tool approval is pending", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        call("shell", "run_shell", {
          command: "printf approved",
          reason: "Check the implementation",
        }),
      ]);
      yield* context.run();
      const response = yield* Effect.provideContext(
        context.agent.status(context.session.id, null),
        yield* context.runtime.contextEffect,
      );
      expect(yield* sdkCall(() => response.json())).toMatchObject({
        lastRun: { status: "interrupted" },
      });
      expect(context.provider!.adapter.invocations).toHaveLength(1);
    }),
  ),
);

it.live("cancel stops a pending continuation before it starts", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([{ text: "I will review." }]);
      yield* context.run();
      expect((yield* context.readExecution()).kind).toBe("ready");
      const response = yield* Effect.provideContext(
        context.agent.cancel(context.session.id, null),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      expect(yield* context.readExecution()).toEqual({ kind: "stopped", reason: "user" });
      const reopened = yield* sdkCall(() => context.reopen());
      yield* Effect.provideContext(AgentChat, yield* reopened.contextEffect);
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(WorkflowExecution, (execution) => execution.readySessions()),
          yield* reopened.contextEffect,
        ),
      ).toHaveLength(0);
      expect(context.provider!.adapter.invocations).toHaveLength(1);
    }),
  ),
);

it.live("a material Plan revision stops automatic execution for confirmation", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        call("replan", "update_plan", { ...plan, summary: "Different acceptance criteria" }),
        { text: "Review the revised Plan." },
      ]);
      yield* context.run();
      expect(
        (yield* Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        )).phase,
      ).toBe("plan");
      expect(yield* context.readExecution()).toEqual({
        kind: "stopped",
        reason: "workflow_changed",
      });
      expect(context.provider!.adapter.invocations).toHaveLength(2);
    }),
  ),
);

it.live("repairs failed verification in Execute before trying Verify again", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
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
      yield* context.run();
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
      expect(context.provider!.adapter.invocations[4]?.systemPrompts.join("\n")).toContain(
        "Workflow phase: execute",
      );
      expect(context.provider!.adapter.invocations[6]?.systemPrompts.join("\n")).toContain(
        "Workflow phase: verify",
      );
    }),
  ),
);

it.live("a new user turn can resume execution after the no-progress limit", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "I will review." },
        { text: "I will review next." },
        call("implementation", "update_workflow_progress", completed()),
        { text: "Implemented." },
        call("verification", "update_workflow_progress", passed),
        { text: "Verified." },
      ]);
      yield* context.run();
      yield* waitFor(context.readExecution().pipe(Effect.map((state) => state.kind)), "blocked");
      // The terminal chunk is delivered before the producer releases its session claim.
      yield* waitFor(
        Effect.gen(function* () {
          const status = yield* Effect.provideContext(
            context.agent.status(context.session.id, null),
            yield* context.runtime.contextEffect,
          );
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) }),
          )(yield* sdkCall(() => status.json()));
          return decoded.running === null;
        }),
        true,
      );
      yield* context.run("user-resume");
      yield* waitFor(
        Effect.provideContext(
          context.workflows.get(context.session.id),
          yield* context.runtime.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
    }),
  ),
);

it.live("repeating the same evidence does not reset the no-progress limit", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const partial = { planEvidence: ["Same check result"], detail: "Checked again" };
      const context = yield* setup([
        call("first", "update_workflow_progress", partial),
        { text: "Partial work." },
        call("second", "update_workflow_progress", partial),
        { text: "Same check." },
        call("third", "update_workflow_progress", partial),
        { text: "Same check again." },
      ]);
      yield* context.run();
      yield* waitFor(context.readExecution().pipe(Effect.map((state) => state.kind)), "blocked");
      expect(context.provider!.adapter.invocations).toHaveLength(6);
    }),
  ),
);

it.live("a failed model run does not automatically retry", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([{ text: "I will check.", failAfterText: "provider failed" }]);
      yield* context.run();
      expect(yield* context.readExecution()).toEqual({ kind: "stopped", reason: "run_failed" });
      expect(context.provider!.adapter.invocations).toHaveLength(1);
    }),
  ),
);

it.live("reopens only a clean completed run with a persisted pending continuation", () =>
  withTestPlatform(
    Effect.gen(function* () {
      const context = yield* setup([
        { text: "I will review next." },
        call("implementation", "update_workflow_progress", completed()),
        { text: "Implemented." },
        call("verification", "update_workflow_progress", passed),
        { text: "Verified." },
      ]);
      yield* context.run();
      const reopened = yield* sdkCall(() => context.reopen());
      yield* Effect.provideContext(AgentChat, yield* reopened.contextEffect);
      const workflows = yield* Effect.provideContext(Workflows, yield* reopened.contextEffect);
      yield* waitFor(
        Effect.provideContext(
          workflows.get(context.session.id),
          yield* reopened.contextEffect,
        ).pipe(Effect.map((state) => state.goal?.status)),
        "completed",
      );
    }),
  ),
);

const sdkCall = Effect.fn("WorkflowExecutionTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const waitFor = Effect.fn("WorkflowExecutionTest.waitFor")(
  <A, E>(read: Effect.Effect<A, E>, expected: A) =>
    read.pipe(
      Effect.repeat({ until: (value) => value === expected, schedule: Schedule.spaced(10) }),
      Effect.timeout("1 second"),
    ),
);
