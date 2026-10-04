import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const goal = {
  statement: "original",
  outcomes: ["original result"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

test.each(["goal", "completed"] as const)(
  "actual chat in %s accepts intent, then applies after run completion",
  async (phase) => {
    let sawId: string | null = null;
    let observedBeforeRunCompleted = false;
    let inspectDb: Database["Service"] | null = null;
    let sessionForResponder = "";
    const context = await testRuntime({
      testProvider: {
        responder: async (invocation) => {
          const toolResult = invocation.messages.find(
            (message) => message.role === "tool" && message.toolCallId === "request-new-goal",
          );
          if (toolResult) {
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
          if (!id) throw new Error("Current Goal ID absent from prompt");
          sawId = id;
          return {
            toolCalls: [
              {
                id: "request-new-goal",
                name: "start_new_goal",
                arguments: JSON.stringify({
                  action: "new_independent_goal",
                  previousGoalInstanceId: id,
                  reason: "new independent task",
                  goal: { ...goal, statement: "new task", outcomes: ["new result"] },
                }),
              },
            ],
          };
        },
      },
    });
    await context.provider!.select(context.runtime);
    const { chat, workflows, db } = await context.runtime.runPromise(
      Effect.all({ chat: AgentChat, workflows: Workflows, db: Database }),
    );
    const session = context.session.id;
    inspectDb = db;
    sessionForResponder = session;
    await context.runtime.runPromise(workflows.setPhase(session, "goal"));
    await context.runtime.runPromise(workflows.updateGoal(session, goal));
    if (phase === "completed") {
      await context.runtime.runPromise(
        workflows.updatePlan(session, {
          summary: "original method",
          steps: [],
          risks: [],
          openQuestions: [],
          status: "ready",
        }),
      );
      await context.runtime.runPromise(workflows.setPhase(session, "verify"));
      await context.runtime.runPromise(
        workflows.updateProgress(session, {
          goalStatus: "completed",
          goalEvidence: ["verified"],
          planEvidence: [],
          steps: [],
          verification: { status: "passed", summary: "closed", evidence: ["verified"] },
          detail: "closed old task",
        }),
      );
      await context.runtime.runPromise(workflows.finishRun(session, "verify"));
      expect((await context.runtime.runPromise(workflows.get(session))).phase).toBe("completed");
    }
    const previousId = await context.runtime.runPromise(workflows.goalInstanceId(session));
    const response = await context.runtime.runPromise(
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session,
            runId: "new-goal-chat-run",
            messages: [
              { id: "user-1", role: "user", content: "Please start a new independent goal" },
            ],
            tools: [],
            context: [],
          }),
        }),
        session,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(sawId).toBe(previousId);
    expect(observedBeforeRunCompleted).toBe(true);
    expect(body).toContain("The request was accepted, not saved yet.");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const row = db.sqlite
        .prepare("SELECT status FROM workflow_new_goal_requests WHERE run_id = 'new-goal-chat-run'")
        .get();
      if (row?.status !== "accepted") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      db.sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = 'new-goal-chat-run'").get(),
    ).toEqual({ status: "completed" });
    expect(
      db.sqlite
        .prepare("SELECT status FROM workflow_new_goal_requests WHERE run_id = 'new-goal-chat-run'")
        .get(),
    ).toEqual({ status: "applied" });
    expect(await context.runtime.runPromise(workflows.goalInstanceId(session))).not.toBe(
      previousId,
    );
    expect((await context.runtime.runPromise(workflows.get(session))).goal?.statement).toBe(
      "new task",
    );
  },
);

test.each(["stale-id", "failed-run"] as const)(
  "actual chat %s never applies a new Goal",
  async (scenario) => {
    const context = await testRuntime({
      testProvider: {
        responder: async (invocation) => {
          if (invocation.messages.some((message) => message.role === "tool")) {
            if (scenario === "failed-run") throw new Error("provider continuation failed");
            return { text: "The stale ID was refused." };
          }
          const id = invocation.systemPrompts
            .join("\n")
            .match(/Current Goal instance ID: ([\w-]+)\./)?.[1];
          if (!id) throw new Error("Goal ID missing");
          return {
            toolCalls: [
              {
                id: "request-new-goal",
                name: "start_new_goal",
                arguments: JSON.stringify({
                  action: "new_independent_goal",
                  previousGoalInstanceId: scenario === "stale-id" ? "stale-id" : id,
                  reason: "independent task",
                  goal: { ...goal, statement: "not saved" },
                }),
              },
            ],
          };
        },
      },
    });
    await context.provider!.select(context.runtime);
    const { chat, workflows, db } = await context.runtime.runPromise(
      Effect.all({ chat: AgentChat, workflows: Workflows, db: Database }),
    );
    const session = context.session.id;
    await context.runtime.runPromise(workflows.setPhase(session, "goal"));
    await context.runtime.runPromise(workflows.updateGoal(session, goal));
    const previousId = await context.runtime.runPromise(workflows.goalInstanceId(session));
    const response = await context.runtime.runPromise(
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session,
            runId: `new-goal-${scenario}`,
            messages: [{ id: "user-1", role: "user", content: "new goal" }],
            tools: [],
            context: [],
          }),
        }),
        session,
      ),
    );
    expect(response.status).toBe(200);
    await response.text();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const row = db.sqlite
        .prepare("SELECT status FROM chat_runs WHERE run_id = ?")
        .get(`new-goal-${scenario}`);
      const request = db.sqlite
        .prepare("SELECT status FROM workflow_new_goal_requests WHERE run_id = ?")
        .get(`new-goal-${scenario}`);
      if (row?.status !== "running" && (!request || request.status !== "accepted")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    expect(await context.runtime.runPromise(workflows.goalInstanceId(session))).toBe(previousId);
    expect((await context.runtime.runPromise(workflows.get(session))).goal?.statement).toBe(
      "original",
    );
  },
);
