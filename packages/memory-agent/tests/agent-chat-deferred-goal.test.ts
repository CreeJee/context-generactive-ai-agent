import { it } from "@effect/vitest";
import { waitUntil } from "./support/wait-until.ts";
import { defaultTestResponder, selectTestModel } from "./support/provider.ts";
import { isTruthy } from "../src/truthy.ts";
import { Cause, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const sdkCall = Effect.fn("deferredGoalTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const goal = {
  statement: "original",
  outcomes: ["original result"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

it.live.each(["goal", "completed"] as const)(
  "actual chat in %s accepts intent, then applies after run completion",
  (phase) =>
    Effect.gen(function* () {
      let sawId: string | null = null;
      let observedBeforeRunCompleted = false;
      let inspectDb: Database["Service"] | null = null;
      let sessionForResponder = "";
      const context = yield* sdkCall(() =>
        testRuntime({
          testProvider: {
            responder: Effect.fn("deferredGoalTest.responder")(function* (
              invocation: Parameters<typeof defaultTestResponder>[0],
            ) {
              const toolResult = invocation.messages.find(
                (message) => message.role === "tool" && message.toolCallId === "request-new-goal",
              );
              if (isTruthy(toolResult)) {
                expect(
                  inspectDb?.sqlite
                    .prepare(
                      "SELECT status FROM workflow_new_goal_requests WHERE run_id = 'new-goal-chat-run'",
                    )
                    .get(),
                ).toEqual({ status: "accepted" });
                expect(
                  inspectDb?.sqlite
                    .prepare(
                      "SELECT goal_instance_id FROM workflow_goal_identities WHERE session_id = ?",
                    )
                    .get(sessionForResponder),
                ).toEqual({ goal_instance_id: sawId });
                observedBeforeRunCompleted = true;
                return { text: "The request was accepted, not saved yet." };
              }
              const instructions = invocation.systemPrompts.join("\n");
              const id = instructions.match(/Current Goal instance ID: ([\w-]+)\./)?.[1];
              if (!isTruthy(id)) throw new Error("Current Goal ID absent from prompt");
              sawId = id;
              return {
                toolCalls: [
                  {
                    id: "request-new-goal",
                    name: "start_new_goal",
                    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                      action: "new_independent_goal",
                      previousGoalInstanceId: id,
                      reason: "new independent task",
                      goal: { ...goal, statement: "new task", outcomes: ["new result"] },
                    }).pipe(Effect.orDie),
                  },
                ],
              };
            }),
          },
        }),
      );
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const { chat, workflows, db } = yield* Effect.provideContext(
        Effect.all({ chat: AgentChat, workflows: Workflows, db: Database }),
        yield* context.runtime.contextEffect,
      );
      const session = context.session.id;
      inspectDb = db;
      sessionForResponder = session;
      yield* Effect.provideContext(
        workflows.setPhase(session, "goal"),
        yield* context.runtime.contextEffect,
      );
      yield* Effect.provideContext(
        workflows.updateGoal(session, goal),
        yield* context.runtime.contextEffect,
      );
      if (phase === "completed") {
        yield* Effect.provideContext(
          workflows.updatePlan(session, {
            summary: "original method",
            steps: [],
            risks: [],
            openQuestions: [],
            status: "ready",
          }),
          yield* context.runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.setPhase(session, "verify"),
          yield* context.runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.updateProgress(session, {
            goalStatus: "completed",
            goalEvidence: ["verified"],
            planEvidence: [],
            steps: [],
            verification: { status: "passed", summary: "closed", evidence: ["verified"] },
            detail: "closed old task",
          }),
          yield* context.runtime.contextEffect,
        );
        yield* Effect.provideContext(
          workflows.finishRun(session, "verify"),
          yield* context.runtime.contextEffect,
        );
        expect(
          (yield* Effect.provideContext(
            workflows.get(session),
            yield* context.runtime.contextEffect,
          )).phase,
        ).toBe("completed");
      }
      const previousId = yield* Effect.provideContext(
        workflows.goalInstanceId(session),
        yield* context.runtime.contextEffect,
      );
      const response = yield* Effect.provideContext(
        chat.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: session,
              runId: "new-goal-chat-run",
              messages: [
                { id: "user-1", role: "user", content: "Please start a new independent goal" },
              ],
              tools: [],
              context: [],
            }).pipe(Effect.orDie),
          }),
          session,
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      const body = yield* sdkCall(() => response.text());
      expect(sawId).toBe(previousId);
      expect(observedBeforeRunCompleted).toBe(true);
      expect(body).toContain("The request was accepted, not saved yet.");
      yield* waitUntil(
        () =>
          db.sqlite
            .prepare(
              "SELECT status FROM workflow_new_goal_requests WHERE run_id = 'new-goal-chat-run'",
            )
            .get()?.status !== "accepted",
        "accepted Goal request settles",
        3000,
      );
      expect(
        db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'new-goal-chat-run'").get(),
      ).toEqual({ status: "completed" });
      expect(
        db.sqlite
          .prepare(
            "SELECT status FROM workflow_new_goal_requests WHERE run_id = 'new-goal-chat-run'",
          )
          .get(),
      ).toEqual({ status: "applied" });
      expect(
        yield* Effect.provideContext(
          workflows.goalInstanceId(session),
          yield* context.runtime.contextEffect,
        ),
      ).not.toBe(previousId);
      expect(
        (yield* Effect.provideContext(workflows.get(session), yield* context.runtime.contextEffect))
          .goal?.statement,
      ).toBe("new task");
    }),
);

it.live.each(["stale-id", "failed-run"] as const)(
  "actual chat %s never applies a new Goal",
  (scenario) =>
    Effect.gen(function* () {
      const context = yield* sdkCall(() =>
        testRuntime({
          testProvider: {
            responder: Effect.fn("deferredGoalTest.responder")(function* (
              invocation: Parameters<typeof defaultTestResponder>[0],
            ) {
              if (invocation.messages.some((message) => message.role === "tool")) {
                if (scenario === "failed-run") throw new Error("provider continuation failed");
                return { text: "The stale ID was refused." };
              }
              const id = invocation.systemPrompts
                .join("\n")
                .match(/Current Goal instance ID: ([\w-]+)\./)?.[1];
              if (!isTruthy(id)) throw new Error("Goal ID missing");
              return {
                toolCalls: [
                  {
                    id: "request-new-goal",
                    name: "start_new_goal",
                    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                      action: "new_independent_goal",
                      previousGoalInstanceId: scenario === "stale-id" ? "stale-id" : id,
                      reason: "independent task",
                      goal: { ...goal, statement: "not saved" },
                    }).pipe(Effect.orDie),
                  },
                ],
              };
            }),
          },
        }),
      );
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const { chat, workflows, db } = yield* Effect.provideContext(
        Effect.all({ chat: AgentChat, workflows: Workflows, db: Database }),
        yield* context.runtime.contextEffect,
      );
      const session = context.session.id;
      yield* Effect.provideContext(
        workflows.setPhase(session, "goal"),
        yield* context.runtime.contextEffect,
      );
      yield* Effect.provideContext(
        workflows.updateGoal(session, goal),
        yield* context.runtime.contextEffect,
      );
      const previousId = yield* Effect.provideContext(
        workflows.goalInstanceId(session),
        yield* context.runtime.contextEffect,
      );
      const response = yield* Effect.provideContext(
        chat.handle(
          new Request("http://localhost/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              threadId: session,
              runId: `new-goal-${scenario}`,
              messages: [{ id: "user-1", role: "user", content: "new goal" }],
              tools: [],
              context: [],
            }).pipe(Effect.orDie),
          }),
          session,
        ),
        yield* context.runtime.contextEffect,
      );
      expect(response.status).toBe(200);
      yield* sdkCall(() => response.text());
      yield* waitUntil(
        () => {
          const row = db.sqlite
            .prepare("SELECT status FROM chat_runs WHERE run_id = ?")
            .get("new-goal-" + scenario);
          const request = db.sqlite
            .prepare("SELECT status FROM workflow_new_goal_requests WHERE run_id = ?")
            .get("new-goal-" + scenario);
          return row?.status !== "running" && (!isTruthy(request) || request.status !== "accepted");
        },
        "failed/stale Goal request settles",
        3000,
      );
      if (scenario === "stale-id") {
        expect(
          db.sqlite.prepare("SELECT count(*) AS n FROM workflow_new_goal_requests").get(),
        ).toEqual({ n: 0 });
      } else {
        expect(
          db.sqlite.prepare("SELECT status, reason FROM workflow_new_goal_requests").get(),
        ).toEqual({ status: "rejected", reason: "run_outcome_uncertain" });
        expect(
          db.sqlite
            .prepare("SELECT status FROM chat_runs WHERE run_id = ?")
            .get(`new-goal-${scenario}`),
        ).toEqual({ status: "failed" });
      }
      expect(
        yield* Effect.provideContext(
          workflows.goalInstanceId(session),
          yield* context.runtime.contextEffect,
        ),
      ).toBe(previousId);
      expect(
        (yield* Effect.provideContext(workflows.get(session), yield* context.runtime.contextEffect))
          .goal?.statement,
      ).toBe("original");
    }),
);
