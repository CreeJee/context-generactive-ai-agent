import {
  Array as EffectArray,
  Cause,
  Deferred,
  Effect,
  FileSystem,
  MutableHashMap,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { messageText } from "../../src/agent/compaction.ts";
import type { JsonValue as Json } from "../../src/json.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { BackgroundTasks } from "../../src/tools/background.ts";
import type {
  ScriptedResponder,
  ScriptedToolCall,
  ScriptedTurn,
} from "../../src/testing/scripted-model.ts";
import { WorkflowExecution, WorkflowExecutionState } from "../../src/workflow/execution.ts";
import {
  type UpdatePlan,
  UpdateWorkflowProgress,
  Workflows,
  WorkflowState,
} from "../../src/workflow/workflow.ts";
import { runTurn } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { sqlGet } from "../support/sql.ts";

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
const implementAndVerify: readonly ScriptedTurn[] = [
  call("implementation", "update_workflow_progress", completed()),
  { text: "Implemented." },
  call("verification", "update_workflow_progress", passed),
  { text: "Verified." },
];

interface Script {
  readonly turns: readonly ScriptedTurn[];
  readonly cite: (
    toolCall: ScriptedToolCall,
  ) => Effect.Effect<ScriptedToolCall, Cause.UnknownError>;
}

/** The shared model answers each session from that session's own script. */
const scripts = MutableHashMap.empty<string, Script>();

const responder: ScriptedResponder = (invocation) =>
  Effect.gen(function* () {
    const threadId = invocation.run.threadId;
    const script = Option.getOrUndefined(MutableHashMap.get(scripts, threadId));
    const [turn, ...rest] = script?.turns ?? [];
    if (script === undefined || turn === undefined)
      return yield* new Cause.UnknownError(undefined, `Unexpected model iteration in ${threadId}`);
    MutableHashMap.set(scripts, threadId, { ...script, turns: rest });
    if (turn.toolCalls === undefined) return turn;
    return { ...turn, toolCalls: yield* Effect.forEach(turn.toolCalls, script.cite) };
  });

const LatestRevision = Schema.Struct({ state_json: Schema.fromJsonString(WorkflowState) });
const Proof = Schema.Struct({ id: Schema.String, run_id: Schema.String });

/** The scripted model cites actual successful owner tool results, as the production model must. */
const citeProof = Effect.fnUntraced(function* (sessionId: string, toolCall: ScriptedToolCall) {
  if (toolCall.name !== "update_workflow_progress") return toolCall;
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(UpdateWorkflowProgress))(
    toolCall.arguments,
  );
  if (input.verification?.status !== "passed") return toolCall;
  const { state_json: state } = yield* Schema.decodeUnknownEffect(LatestRevision)(
    yield* sqlGet(
      "SELECT state_json FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      sessionId,
    ),
  );
  const proof = yield* Schema.decodeUnknownEffect(Proof)(
    yield* sqlGet(
      `SELECT n.id, n.run_id FROM nodes n JOIN chat_runs r ON r.run_id = n.run_id
        WHERE n.session_id = ? AND n.kind = 'tool_result' AND json_extract(n.detail, '$.ok') = 1 AND r.status = 'completed' ORDER BY n.seq DESC LIMIT 1`,
      sessionId,
    ),
  );
  const step = state.plan?.steps.find((candidate) => candidate.status === "done");
  if (state.goal === null || step === undefined)
    return yield* new Cause.UnknownError(undefined, "Missing completed step");
  const outcomes = state.goal.outcomes;
  return {
    ...toolCall,
    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...input,
      criterionMappings: outcomes.map((outcomeText, outcomeIndex) => ({
        outcomeIndex,
        outcomeText,
        stepId: step.id,
        acceptanceIndex: 0,
        acceptanceText: step.acceptanceCriteria[0],
        runId: proof.run_id,
        evidenceNodeIds: [proof.id],
      })),
    }),
  };
});

const waitFor = <A, E>(read: Effect.Effect<A, E>, expected: A) =>
  read.pipe(
    Effect.repeat({ until: (value) => value === expected, schedule: Schedule.spaced(10) }),
    Effect.timeout("5 seconds"),
  );

const RunningStatus = Schema.Struct({
  running: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
});
const LastRunStatus = Schema.Struct({ lastRun: Schema.Struct({ status: Schema.String }) });

/**
 * A fresh session executing the approved Plan, answered by `turns`. Reads go through `env.use`, so
 * they follow the agent across `env.reopen`.
 */
const executing = Effect.fnUntraced(function* (
  turns: readonly ScriptedTurn[],
  steps: UpdatePlan["steps"] = plan.steps,
) {
  const env = yield* TestEnv;
  const id = (yield* env.use(
    Effect.flatMap(Sessions, (sessions) => sessions.create(env.project.id)),
  )).id;
  MutableHashMap.set(scripts, id, {
    turns,
    cite: (toolCall) =>
      env
        .use(citeProof(id, toolCall))
        .pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(scripts, id)));
  yield* env.use(
    Effect.gen(function* () {
      yield* selectTestModel();
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, { ...plan, steps });
      yield* workflows.setPhase(id, "execute");
    }),
  );
  const agent = env.use(AgentChat);
  const status = Effect.flatMap(agent, (chat) => chat.status(id, null)).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new Cause.UnknownError(cause),
      }),
    ),
  );
  return {
    id,
    invocations: () => env.provider!.invocations.filter((turn) => turn.run.threadId === id),
    run: (runId = "initial") => runTurn(id, `${id}-${runId}`, "Execute the approved Plan"),
    cancel: Effect.flatMap(agent, (chat) => chat.cancel(id, null)),
    status,
    execution: env.use(Effect.flatMap(WorkflowExecution, (execution) => execution.get(id))),
    readySessions: env.use(
      Effect.flatMap(WorkflowExecution, (execution) => execution.readySessions()),
    ),
    goalStatus: env.use(
      Effect.flatMap(Workflows, (workflows) => workflows.get(id)).pipe(
        Effect.map((state) => state.goal?.status),
      ),
    ),
  };
});

type Session = Effect.Success<ReturnType<typeof executing>>;

const writeContract = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(project.root, "contract.txt"), "Acceptance contract\n");
});

const completesGoal = (session: Session) => waitFor(session.goalStatus, "completed");
const isBlocked = WorkflowExecutionState.isAnyOf(["blocked"]);
const stopped = (reason: (typeof WorkflowExecutionState.cases.stopped.Type)["reason"]) =>
  WorkflowExecutionState.cases.stopped.make({ reason });
const blocks = Effect.fnUntraced(function* (session: Session) {
  yield* waitFor(session.execution.pipe(Effect.map(isBlocked)), true);
  expect(yield* session.execution).toMatchObject({ reason: "repeated_failure" });
});

testAgent({ testProvider: { responder } })("automatic workflow execution", (it) => {
  it.effect("continues a promise-only turn without a browser and verifies the completed Plan", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        { text: "I will review this next." },
        ...implementAndVerify,
      ]);
      yield* session.run();
      yield* completesGoal(session);
      const invocations = session.invocations();
      expect(invocations).toHaveLength(5);
      expect(EffectArray.dedupe(invocations.map((turn) => turn.run.runId))).toHaveLength(3);
      expect(messageText(invocations[1]!.history.at(-1)!)).toContain(
        "automatic continuation of the already approved Plan",
      );
      expect(invocations[3]?.system.join("\n")).toContain("Workflow phase: verify");
      expect(
        (yield* (yield* Nodes).session(session.id)).filter((node) => node.kind === "user"),
      ).toHaveLength(1);
      expect(yield* session.execution).toEqual(stopped("completed"));
    }),
  );

  it.effect.each([
    {
      progress: "new evidence before a step completes",
      turns: [
        { text: "Next I will inspect." },
        call("partial", "update_workflow_progress", {
          planEvidence: ["Read the current contract"],
          detail: "Investigated",
        }),
        { text: "Contract inspected." },
      ],
    },
    {
      progress: "a successful read investigation",
      turns: [
        { text: "Next I will inspect the contract." },
        call("read-contract", "read_file", { path: "contract.txt" }),
        { text: "The contract is inspected." },
      ],
    },
    {
      progress: "successful file creation",
      turns: [
        { text: "Next I will implement." },
        call("write", "write_file", { path: "implementation.txt", content: "Implemented\n" }),
        { text: "File written." },
      ],
    },
  ])("$progress resets the consecutive no-progress limit", ({ turns }) =>
    Effect.gen(function* () {
      const session = yield* executing([
        ...turns,
        { text: "Next I will check." },
        ...implementAndVerify,
      ]);
      yield* writeContract;
      yield* session.run();
      yield* completesGoal(session);
      expect(session.invocations()).toHaveLength(8);
    }),
  );

  it.effect.each([
    {
      repeat: "identical successful read results",
      turns: [
        call("read-1", "read_file", { path: "contract.txt" }),
        { text: "Read the contract." },
        call("read-2", "read_file", { path: "contract.txt" }),
        { text: "Read it again." },
        call("read-3", "read_file", { path: "contract.txt" }),
        { text: "Read the same contract again." },
      ],
    },
    {
      repeat: "failed read investigations",
      turns: [
        call("missing-1", "read_file", { path: "missing-one.txt" }),
        { text: "The first file was missing." },
        call("missing-2", "read_file", { path: "missing-two.txt" }),
        { text: "The second file was missing." },
      ],
    },
    {
      repeat: "the same evidence",
      turns: [1, 2, 3].flatMap((n) => [
        call(`partial-${n}`, "update_workflow_progress", {
          planEvidence: ["Same check result"],
          detail: "Checked again",
        }),
        { text: "Same check." },
      ]),
    },
  ])("$repeat do not reset the no-progress limit", ({ turns }) =>
    Effect.gen(function* () {
      const session = yield* executing(turns);
      yield* writeContract;
      yield* session.run();
      yield* blocks(session);
      expect(session.invocations()).toHaveLength(turns.length);
    }),
  );

  it.effect("records a confirmed blocker instead of automatically continuing", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        call("blocker", "record_workflow_blocker", {
          reason: "user_decision",
          detail: "Choose the deployment target",
          evidence: ["Two incompatible targets remain"],
        }),
        { text: "Which target should I use?" },
      ]);
      yield* session.run();
      expect(yield* session.execution).toMatchObject({
        reason: "user_decision",
        detail: "Choose the deployment target",
      });
      expect(session.invocations()).toHaveLength(2);
    }),
  );

  it.effect("continues beside a blocked step and stops once no remaining step can start", () =>
    Effect.gen(function* () {
      const [p1] = plan.steps;
      const session = yield* executing(
        [
          call("block-p1", "update_workflow_progress", {
            steps: [{ id: "p1", status: "blocked", evidence: ["Upstream service is down"] }],
            detail: "p1 blocked",
          }),
          { text: "p1 is blocked." },
          call("finish-p3", "update_workflow_progress", {
            steps: [{ id: "p3", status: "completed", evidence: ["Independent step done"] }],
            detail: "p3 done",
          }),
          { text: "p3 is done." },
        ],
        [p1, { ...p1, id: "p2", dependsOn: ["p1"] }, { ...p1, id: "p3" }],
      );
      yield* session.run();
      yield* waitFor(session.execution.pipe(Effect.map(isBlocked)), true);
      expect(yield* session.execution).toMatchObject({
        reason: "dependency_stalled",
        evidence: ["p1 [blocked]", "p2 waits on p1 [blocked]"],
      });
      const invocations = session.invocations();
      expect(invocations).toHaveLength(4);
      expect(invocations[2]?.system.join("\n")).toContain(
        "Ready steps (pending with every dependency completed): p3.",
      );
    }),
  );

  it.effect("does not start another turn while a tool approval is pending", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        call("shell", "save_code_skill", {
          name: "check",
          description: "Check the implementation",
          program: { runtime: "sh", script: "printf approved" },
          reason: "Check the implementation",
        }),
      ]);
      yield* session.run();
      expect(
        (yield* Schema.decodeUnknownEffect(LastRunStatus)(yield* session.status)).lastRun.status,
      ).toBe("interrupted");
      expect(session.invocations()).toHaveLength(1);
    }),
  );

  it.effect("running background work holds the Plan until its completion wakes the session", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        { text: "The check runs in the background." },
        ...implementAndVerify,
      ]);
      const release = yield* Deferred.make<void>();
      yield* (yield* BackgroundTasks).start(
        {
          sessionId: session.id,
          runId: `${session.id}:check`,
          abortSignal: yield* Effect.abortSignal,
        },
        `${session.id}:check`,
        "shell",
        "check",
        Effect.as(Deferred.await(release), { report: "Check passed", failure: null }),
      );
      yield* session.run();
      // Longer than the follow-up's delay, after which an unheld Plan would already continue.
      yield* Effect.sleep("200 millis");
      expect(session.invocations()).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
      yield* completesGoal(session);
      expect(session.invocations()).toHaveLength(5);
    }),
  );

  it.effect("a material Plan revision stops automatic execution for confirmation", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        call("replan", "update_plan", { ...plan, summary: "Different acceptance criteria" }),
        { text: "Review the revised Plan." },
      ]);
      yield* session.run();
      expect((yield* (yield* Workflows).get(session.id)).phase).toBe("plan");
      expect(yield* session.execution).toEqual(stopped("workflow_changed"));
      expect(session.invocations()).toHaveLength(2);
    }),
  );

  it.effect("repairs failed verification in Execute before trying Verify again", () =>
    Effect.gen(function* () {
      const session = yield* executing([
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
      yield* session.run();
      yield* completesGoal(session);
      const invocations = session.invocations();
      expect(invocations[4]?.system.join("\n")).toContain("Workflow phase: execute");
      expect(invocations[6]?.system.join("\n")).toContain("Workflow phase: verify");
    }),
  );

  it.effect("a new user turn can resume execution after the no-progress limit", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        { text: "I will review." },
        { text: "I will review next." },
        ...implementAndVerify,
      ]);
      yield* session.run();
      yield* blocks(session);
      // The terminal chunk is delivered before the producer releases its session claim.
      yield* waitFor(
        session.status.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RunningStatus)),
          Effect.map(({ running }) => running === null),
        ),
        true,
      );
      yield* session.run("user-resume");
      yield* completesGoal(session);
    }),
  );

  it.effect("a failed model run does not automatically retry", () =>
    Effect.gen(function* () {
      const session = yield* executing([
        { text: "I will check.", failAfterText: "provider failed" },
      ]);
      yield* session.run();
      expect(yield* session.execution).toEqual(stopped("run_failed"));
      expect(session.invocations()).toHaveLength(1);
    }),
  );
});

// Reopening replaces the agent behind every service, so these tests read through `env.use` only.
testAgent({ testProvider: { responder } })("automatic workflow execution across reopen", (it) => {
  it.effect("stops after two turns without progress and persists the reason across reopen", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* executing([
        { text: "I need to review." },
        { text: "I will review next." },
      ]);
      yield* session.run();
      yield* blocks(session);
      expect(session.invocations()).toHaveLength(2);
      yield* env.reopen;
      expect(yield* session.execution).toMatchObject({ reason: "repeated_failure" });
      expect(yield* session.readySessions).not.toContain(session.id);
    }),
  );

  it.effect("cancel stops a pending continuation before it starts and across reopen", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* executing([{ text: "I will review." }]);
      yield* session.run();
      expect(WorkflowExecutionState.isAnyOf(["ready"])(yield* session.execution)).toBe(true);
      expect((yield* session.cancel).status).toBe(200);
      expect(yield* session.execution).toEqual(stopped("user"));
      yield* env.reopen;
      expect(yield* session.readySessions).not.toContain(session.id);
      expect(session.invocations()).toHaveLength(1);
    }),
  );

  it.effect("reopens only a clean completed run with a persisted pending continuation", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* executing([{ text: "I will review next." }, ...implementAndVerify]);
      yield* session.run();
      yield* env.reopen;
      yield* completesGoal(session);
    }),
  );
});
