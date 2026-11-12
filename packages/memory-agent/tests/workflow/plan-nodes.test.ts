import { Effect, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Nodes } from "../../src/memory/nodes.ts";
import { PlanNodes } from "../../src/workflow/plan-nodes.ts";
import { WorkflowTools } from "../../src/workflow/tools.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { callTool } from "../support/run-tools.ts";
import { sqlRun } from "../support/sql.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Keep where card instructions come from",
  outcomes: [{ id: "O1", text: "A card cites its Plan" }],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const plan = {
  summary: "Record Plan versions",
  steps: [
    {
      id: "record",
      title: "Record the Plan version",
      description: "Write the version a card starts from",
      dependsOn: [],
      acceptanceCriteria: ["The version is in memory"],
      ruleRefs: [],
      outcomes: [],
    },
  ],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

testAgent()("PlanNodes", (it) => {
  it.effect("a Plan version's node holds the Plan and cites the call that saved it", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const id = yield* freshSession;
      const nodes = yield* Nodes;
      const planNodes = yield* PlanNodes;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const runId = `${id}:run`;
      yield* sqlRun(
        "INSERT INTO chat_runs (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', 1)",
        runId,
        id,
      );
      // The model's update_plan call, as the recorder writes it before the tool runs.
      const call = yield* nodes.append({
        projectId: env.project.id,
        sessionId: id,
        runId,
        kind: "tool_call",
        text: plan.summary,
        detail: { toolName: "update_plan", toolCallId: "call-update_plan" },
      });
      const tools = (yield* WorkflowTools).toolsFor(id, "shaping", runId);
      yield* callTool(tools, "update_plan", plan);

      const first = yield* planNodes.forVersion(id, 1);
      const node = Option.getOrThrow(first);
      expect(node).toMatchObject({
        kind: "plan",
        runId,
        detail: { planVersion: 1 },
      });
      const saved = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.Int, summary: Schema.String })),
      )(node.text);
      expect(saved).toEqual({ version: 1, summary: plan.summary });
      const edges = yield* nodes.edgesOf(node.id);
      expect(edges.map(({ fromId, toId, kind }) => ({ fromId, toId, kind }))).toEqual([
        { fromId: node.id, toId: call.id, kind: "cites" },
      ]);

      // Written once: a card that starts later, after cards moved, gets the same node.
      yield* workflows.move(id, "run");
      expect(Option.map(yield* planNodes.forVersion(id, 1), ({ id }) => id)).toEqual(
        Option.some(node.id),
      );

      // A version saved from the board has no call to cite.
      yield* workflows.updatePlan(id, { ...plan, summary: "Record Plan versions again" });
      const second = Option.getOrThrow(yield* planNodes.forVersion(id, 2));
      expect(second.detail).toMatchObject({ planVersion: 2 });
      expect(second.id).not.toBe(node.id);
      expect(yield* nodes.edgesOf(second.id)).toEqual([]);

      expect(yield* planNodes.forVersion(id, 9)).toEqual(Option.none());
    }),
  );
});
