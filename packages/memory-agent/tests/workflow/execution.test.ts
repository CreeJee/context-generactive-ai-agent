import { Cause, Effect, MutableHashMap, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { CardAttempts } from "../../src/kanban/card-attempts.ts";
import type { JsonValue as Json } from "../../src/json.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedResponder, ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { BoardAuthor } from "../../src/workflow/card.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { runTurn } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/**
 * An approved Plan runs on a kanban board: card agents execute it and the session's chat plans
 * (decisions.md "outcome 장부와 이어 쓰는 Plan, Plan 모드는 카드를 사용자가 승인하는 Goal이다").
 * The chat never executes or continues the Plan itself.
 */

const goal = {
  statement: "Finish the approved work",
  outcomes: [{ id: "O1", text: "Implemented and verified" }],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};
const plan = {
  summary: "Implement",
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
      outcomes: ["O1"],
    },
  ],
};

const call = (id: string, name: string, input: Json): ScriptedTurn => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(input) }],
});

/** The shared model answers each session from that session's own turns. */
const scripts = MutableHashMap.empty<string, readonly ScriptedTurn[]>();

const responder: ScriptedResponder = (invocation) =>
  Effect.gen(function* () {
    const threadId = invocation.run.threadId;
    const [turn, ...rest] = Option.getOrElse(MutableHashMap.get(scripts, threadId), () => []);
    if (turn === undefined)
      return yield* new Cause.UnknownError(undefined, `Unexpected model iteration in ${threadId}`);
    MutableHashMap.set(scripts, threadId, rest);
    return turn;
  });

/** A fresh session whose Goal has a ready Plan, answered by `turns`. */
const planned = Effect.fnUntraced(function* (turns: readonly ScriptedTurn[]) {
  const env = yield* TestEnv;
  const id = (yield* env.use(
    Effect.flatMap(Sessions, (sessions) => sessions.create(env.project.id)),
  )).id;
  MutableHashMap.set(scripts, id, turns);
  yield* Effect.addFinalizer(() => Effect.sync(() => MutableHashMap.remove(scripts, id)));
  yield* env.use(
    Effect.gen(function* () {
      yield* selectTestModel();
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
    }),
  );
  const kanban = env.use(
    Effect.gen(function* () {
      const goalInstanceId = yield* (yield* Workflows).goalInstanceId(id);
      return goalInstanceId === null
        ? Option.none()
        : Option.filter(yield* (yield* CardAttempts).goal(goalInstanceId), (found) => found.active);
    }),
  );
  return {
    id,
    invocations: () => env.provider!.invocations.filter((turn) => turn.run.threadId === id),
    board: Effect.map(kanban, Option.isSome),
  };
});

const waitForBoard = <E>(board: Effect.Effect<boolean, E>) =>
  board.pipe(
    Effect.repeat({ until: (running) => running, schedule: Schedule.spaced(10) }),
    Effect.timeout("5 seconds"),
  );

testAgent({ testProvider: { responder } })("approved Plan execution", (it) => {
  it.effect("approving the Plan runs it on a kanban board", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([]);
      expect(yield* session.board).toBe(false);
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
      // The board executes it; no model turn ran for the approval.
      expect(session.invocations()).toHaveLength(0);
    }),
  );

  it.effect("the board takes over an approved Plan left without one after the next turn", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([{ text: "Noted." }]);
      // Approved before boards ran approved Plans: the phase moved without one.
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "run")));
      expect(yield* session.board).toBe(false);
      yield* runTurn(session.id, `${session.id}-turn`, "How is the Plan going?");
      yield* waitForBoard(session.board);
      // The chat did not continue the Plan after its turn.
      expect(session.invocations()).toHaveLength(1);
    }),
  );

  it.effect("Goal mode runs the cards its planner saved once the run ends", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([
        call("goal", "update_goal", goal),
        call("plan", "update_plan", plan),
        { text: "The board will run the cards." },
      ]);
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "goal")));
      yield* runTurn(session.id, `${session.id}-turn`, "Get this done");
      yield* waitForBoard(session.board);
      const state = yield* env.use(
        Effect.flatMap(Workflows, (workflows) => workflows.get(session.id)),
      );
      expect([state.phase, state.plan?.status]).toEqual(["running", "executing"]);
      // The planner had no project write tools and no progress tool.
      const tools = session.invocations()[0]?.toolNames ?? [];
      expect(tools).toEqual(expect.arrayContaining(["update_goal", "update_plan"]));
      expect(tools).not.toContain("update_workflow_progress");
      expect(tools).not.toContain("write_file");
    }),
  );

  it.effect("the planner of a running board reads the project only but changes the board", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([{ text: "Noted." }]);
      // The held card keeps the board from running cards beside the planner's turn.
      yield* env.use(
        Effect.flatMap(Workflows, (workflows) =>
          workflows.holdCard(
            session.id,
            { cardId: "p1", hold: true },
            BoardAuthor.cases.User.make({}),
          ),
        ),
      );
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
      yield* runTurn(session.id, `${session.id}-turn`, "How is the board going?");
      const tools = session.invocations()[0]?.toolNames ?? [];
      expect(tools).toEqual(expect.arrayContaining(["read_kanban_board", "edit_kanban_board"]));
      expect(tools).not.toContain("write_file");
    }),
  );

  it.effect("a Plan revised on a running board keeps its planner on the board", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([{ text: "Noted." }]);
      yield* env.use(
        Effect.flatMap(Workflows, (workflows) =>
          workflows.holdCard(
            session.id,
            { cardId: "p1", hold: true },
            BoardAuthor.cases.User.make({}),
          ),
        ),
      );
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
      // A revised Plan waits to be confirmed in shaping while its board stays active.
      const state = yield* env.use(
        Effect.flatMap(Workflows, (workflows) => workflows.updatePlan(session.id, plan)),
      );
      expect(state.phase).toBe("shaping");
      expect(yield* session.board).toBe(true);
      yield* runTurn(session.id, `${session.id}-turn`, "Why does the Plan need confirming?");
      const tools = session.invocations()[0]?.toolNames ?? [];
      expect(tools).toEqual(expect.arrayContaining(["read_kanban_board", "edit_kanban_board"]));
    }),
  );

  it.effect("a Goal mode approval runs its Plan on the board that kept running", () =>
    Effect.gen(function* () {
      const env = yield* TestEnv;
      const session = yield* planned([
        call("plan", "update_plan", plan),
        { text: "The board will run the cards." },
      ]);
      // The held card keeps the board from moving cards while the planner writes the Plan.
      yield* env.use(
        Effect.flatMap(Workflows, (workflows) =>
          workflows.holdCard(
            session.id,
            { cardId: "p1", hold: true },
            BoardAuthor.cases.User.make({}),
          ),
        ),
      );
      yield* env.use(
        Effect.flatMap(AgentChat, (chat) => chat.moveWorkflow(session.id, null, "run")),
      );
      yield* waitForBoard(session.board);
      // Back in Goal mode the board stays active while the planner writes the next Plan.
      yield* env.use(Effect.flatMap(Workflows, (workflows) => workflows.move(session.id, "goal")));
      yield* runTurn(session.id, `${session.id}-turn`, "Plan the rest");
      // The owner approves this Plan once the run ends, and the board that kept running runs it.
      const state = yield* env
        .use(Effect.flatMap(Workflows, (workflows) => workflows.get(session.id)))
        .pipe(
          Effect.repeat({
            until: (found) => found.phase === "running" && found.plan?.status === "executing",
            schedule: Schedule.spaced(10),
          }),
          Effect.timeout("5 seconds"),
        );
      expect(state.plan?.status).toBe("executing");
      expect(yield* session.board).toBe(true);
    }),
  );
});
