import { Cause, Effect, MutableHashMap, Option, Schedule } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { CardAttempts } from "../../src/kanban/card-attempts.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedResponder, ScriptedTurn } from "../../src/testing/scripted-model.ts";
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
  const board = env.use(
    Effect.gen(function* () {
      const goalInstanceId = yield* (yield* Workflows).goalInstanceId(id);
      if (goalInstanceId === null) return false;
      return Option.exists(
        yield* (yield* CardAttempts).goal(goalInstanceId),
        (found) => found.active,
      );
    }),
  );
  return {
    id,
    invocations: () => env.provider!.invocations.filter((turn) => turn.run.threadId === id),
    board,
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
        Effect.flatMap(AgentChat, (chat) => chat.setWorkflowPhase(session.id, null, "execute")),
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
      yield* env.use(
        Effect.flatMap(Workflows, (workflows) => workflows.setPhase(session.id, "execute")),
      );
      expect(yield* session.board).toBe(false);
      yield* runTurn(session.id, `${session.id}-turn`, "How is the Plan going?");
      yield* waitForBoard(session.board);
      // The chat did not continue the Plan after its turn.
      expect(session.invocations()).toHaveLength(1);
    }),
  );
});
