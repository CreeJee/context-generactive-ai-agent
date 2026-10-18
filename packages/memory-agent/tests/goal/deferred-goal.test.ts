import { Cause, Effect, MutableHashMap, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedResponder } from "../../src/testing/scripted-adapter.ts";
import { isTruthy } from "../../src/truthy.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";
import { sqlAll, sqlGet } from "../support/sql.ts";

const goal = {
  statement: "original",
  outcomes: ["original result"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

type Scenario = "goal" | "completed" | "stale-id" | "failed-run";

interface Script {
  readonly scenario: Scenario;
  readonly sql: SqlClient.SqlClient;
  /** The Goal instance ID the model read from its prompt. */
  readonly seenId?: string;
  /** Owner state the model observed while the run was still in progress. */
  readonly observed?: { readonly request: unknown; readonly identity: unknown };
}

/** The shared model answers each session from that session's own script. */
const scripts = MutableHashMap.empty<string, Script>();

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const requestStatus = (runId: string) =>
  sqlGet("SELECT status FROM workflow_new_goal_requests WHERE run_id = ?", runId);

/** The continuation after `start_new_goal`, by scenario. */
const continuation = Effect.fnUntraced(function* (threadId: string, runId: string, script: Script) {
  switch (script.scenario) {
    case "goal":
    case "completed":
      MutableHashMap.set(scripts, threadId, {
        ...script,
        observed: yield* Effect.all({
          request: requestStatus(runId),
          identity: sqlGet(
            "SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?",
            threadId,
          ),
        }).pipe(Effect.provideService(SqlClient.SqlClient, script.sql), Effect.orDie),
      });
      return { text: "The request was accepted, not saved yet." };
    case "stale-id":
      return { text: "The stale ID was refused." };
    case "failed-run":
      return yield* new Cause.UnknownError(undefined, "provider continuation failed");
  }
});

const responder: ScriptedResponder = (invocation) =>
  Effect.gen(function* () {
    const threadId = invocation.threadId ?? "";
    const script = Option.getOrUndefined(MutableHashMap.get(scripts, threadId));
    if (script === undefined)
      return yield* new Cause.UnknownError(undefined, `Unexpected model iteration in ${threadId}`);
    if (invocation.messages.some((message) => message.role === "tool"))
      return yield* continuation(threadId, invocation.runId ?? "", script);
    const id = invocation.systemPrompts
      .join("\n")
      .match(/Current Goal instance ID: ([\w-]+)\./)?.[1];
    if (!isTruthy(id)) return yield* new Cause.UnknownError(undefined, "Goal ID missing");
    MutableHashMap.set(scripts, threadId, { ...script, seenId: id });
    const applies = script.scenario === "goal" || script.scenario === "completed";
    return {
      toolCalls: [
        {
          id: "request-new-goal",
          name: "start_new_goal",
          arguments: yield* encodeJson({
            action: "new_independent_goal",
            previousGoalInstanceId: script.scenario === "stale-id" ? "stale-id" : id,
            reason: "new independent task",
            goal: applies
              ? { ...goal, statement: "new task", outcomes: ["new result"] }
              : { ...goal, statement: "not saved" },
          }).pipe(Effect.orDie),
        },
      ],
    };
  });

/** A fresh session whose Goal reached `phase`, answered by its scenario script. */
const sessionIn = Effect.fnUntraced(function* (scenario: Scenario) {
  const { project } = yield* TestEnv;
  const workflows = yield* Workflows;
  yield* selectTestModel();
  const session = (yield* (yield* Sessions).create(project.id)).id;
  MutableHashMap.set(scripts, session, { scenario, sql: yield* SqlClient.SqlClient });
  yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(scripts, session)));
  yield* workflows.setPhase(session, "goal");
  yield* workflows.updateGoal(session, goal);
  if (scenario === "completed") {
    yield* workflows.updatePlan(session, {
      summary: "original method",
      steps: [],
      risks: [],
      openQuestions: [],
      status: "ready",
    });
    yield* workflows.setPhase(session, "verify");
    yield* workflows.updateProgress(session, {
      goalStatus: "completed",
      goalEvidence: ["verified"],
      planEvidence: [],
      steps: [],
      verification: { status: "passed", summary: "closed", evidence: ["verified"] },
      detail: "closed old task",
    });
    yield* workflows.finishRun(session, "verify");
    expect((yield* workflows.get(session)).phase).toBe("completed");
  }
  return session;
});

/** Ask for a new independent Goal through a real chat turn and wait until the run settles. */
const requestNewGoal = Effect.fnUntraced(function* (session: string) {
  const runId = `${session}:new-goal`;
  const response = yield* (yield* AgentChat).handle(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: yield* encodeJson({
        threadId: session,
        runId,
        messages: [{ id: "user-1", role: "user", content: "Please start a new independent goal" }],
        tools: [],
        context: [],
      }).pipe(Effect.orDie),
    }),
    session,
  );
  expect(response.status).toBe(200);
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* waitUntil(
    Effect.zipWith(
      sqlGet("SELECT status FROM chat_runs WHERE run_id = ?", runId),
      requestStatus(runId),
      (run, request) => run?.status !== "running" && request?.status !== "accepted",
    ),
    "new Goal request settles",
    3000,
  );
  return { runId, body };
});

testAgent({ testProvider: { responder } })("deferred new Goal through chat", (it) => {
  it.effect.each(["goal", "completed"] as const)(
    "chat in %s accepts intent, then applies it after run completion",
    (phase) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        const session = yield* sessionIn(phase);
        const previousId = yield* workflows.goalInstanceId(session);
        const { runId, body } = yield* requestNewGoal(session);
        const script = Option.getOrUndefined(MutableHashMap.get(scripts, session));
        expect(script?.seenId).toBe(previousId);
        // While the run was still in progress the request was accepted, not applied.
        expect(script?.observed).toEqual({
          request: { status: "accepted" },
          identity: { goal_instance_id: previousId },
        });
        expect(body).toContain("The request was accepted, not saved yet.");
        expect(yield* sqlGet("SELECT status FROM chat_runs WHERE run_id = ?", runId)).toEqual({
          status: "completed",
        });
        expect(yield* requestStatus(runId)).toEqual({ status: "applied" });
        expect(yield* workflows.goalInstanceId(session)).not.toBe(previousId);
        expect((yield* workflows.get(session)).goal?.statement).toBe("new task");
      }),
  );

  it.effect.each(["stale-id", "failed-run"] as const)(
    "chat with %s never applies a new Goal",
    (scenario) =>
      Effect.gen(function* () {
        const workflows = yield* Workflows;
        const session = yield* sessionIn(scenario);
        const previousId = yield* workflows.goalInstanceId(session);
        const { runId } = yield* requestNewGoal(session);
        const requests = yield* sqlAll(
          "SELECT status, reason FROM workflow_new_goal_requests WHERE session_id = ?",
          session,
        );
        switch (scenario) {
          case "stale-id":
            expect(requests).toEqual([]);
            break;
          case "failed-run":
            expect(requests).toEqual([{ status: "rejected", reason: "run_outcome_uncertain" }]);
            expect(yield* sqlGet("SELECT status FROM chat_runs WHERE run_id = ?", runId)).toEqual({
              status: "failed",
            });
            break;
        }
        expect(yield* workflows.goalInstanceId(session)).toBe(previousId);
        expect((yield* workflows.get(session)).goal?.statement).toBe("original");
      }),
  );
});
