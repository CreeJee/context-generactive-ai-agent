import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { KanbanBoardActions } from "../../src/kanban/board-actions.ts";
import { BoardIntent } from "../../src/workflow/board-edit.ts";
import { BoardAuthor } from "../../src/workflow/card.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Run a Goal as a board",
  outcomes: ["Cards can move between boards"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const step = (id: string, dependsOn: readonly string[] = [], risk?: "low" | "medium" | "high") => {
  const card = {
    id,
    title: `Card ${id}`,
    description: id,
    dependsOn,
    acceptanceCriteria: [`${id} done`],
    ruleRefs: [],
  };
  return risk === undefined ? card : { ...card, risk };
};

const plan = (ids: ReadonlyArray<ReturnType<typeof step>>) => ({
  summary: "Board",
  steps: ids,
  risks: [],
  openQuestions: [],
  status: "ready" as const,
});

const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "run-1" });
const user = BoardAuthor.cases.User.make({});

testAgent()("card transfer between boards", (it) => {
  it.effect("moves a card to another conversation's Plan without its dependencies", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const actions = yield* KanbanBoardActions;
      const from = yield* freshSession;
      const to = yield* freshSession;
      yield* workflows.updateGoal(from, goal);
      yield* workflows.updatePlan(from, plan([step("a"), step("b", ["a"], "high")]), orchestrator);
      yield* workflows.updateGoal(to, goal);
      yield* workflows.updatePlan(to, plan([step("x"), step("y")]), orchestrator);

      const refused = (intent: BoardIntent) =>
        actions.applyIntent(from, intent, user).pipe(
          Effect.as(null),
          Effect.catchTags({
            KanbanActionRefused: (error) => Effect.succeed(error.reason),
            BoardEditRefused: (error) => Effect.succeed(error.reason),
          }),
        );
      // b waits for a, so a cannot leave; a Plan cannot receive its own card.
      expect(
        yield* refused(BoardIntent.cases.Transfer.make({ cardId: "a", toSessionId: to, at: null })),
      ).toBe("card_has_dependents");
      expect(
        yield* refused(
          BoardIntent.cases.Transfer.make({ cardId: "b", toSessionId: from, at: null }),
        ),
      ).toBe("transfer_target_invalid");

      yield* actions.applyIntent(
        from,
        BoardIntent.cases.Transfer.make({ cardId: "b", toSessionId: to, at: "y" }),
        user,
      );
      const left = (yield* workflows.get(from)).plan?.steps ?? [];
      expect(left.map((card) => card.id)).toEqual(["a"]);
      const arrived = (yield* workflows.get(to)).plan?.steps ?? [];
      expect(arrived.map((card) => card.title)).toEqual(["Card x", "Card b", "Card y"]);
      const moved = arrived[1];
      // The card gets the target Plan's own id, keeps its contract and starts unblocked.
      expect(moved?.id).not.toBe("b");
      expect(moved?.dependsOn).toEqual([]);
      expect(moved?.risk).toBe("high");
      expect(moved?.acceptanceCriteria).toEqual(["b done"]);
      expect(moved?.status).toBe("ready");
    }),
  );
});
