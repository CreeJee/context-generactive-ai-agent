import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { KanbanBoardActions } from "../../src/kanban/board-actions.ts";
import { GoalOrder } from "../../src/kanban/goal-order.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { Boards } from "../../src/workflow/board.ts";
import { BoardIntent } from "../../src/workflow/board-edit.ts";
import { BoardAuthor } from "../../src/workflow/card.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Run a Goal as a board",
  outcomes: ["Goals are ordered in the project"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const step = (id: string) => ({
  id,
  title: `Card ${id}`,
  description: id,
  dependsOn: [],
  acceptanceCriteria: [`${id} done`],
  ruleRefs: [],
});

const plan = (ids: readonly string[]) => ({
  summary: "Board",
  steps: ids.map(step),
  risks: [],
  openQuestions: [],
  status: "ready" as const,
});

const orchestrator = BoardAuthor.cases.Orchestrator.make({ runId: "run-1" });
const user = BoardAuthor.cases.User.make({});

testAgent()("priority tree of a project's Goals", (it) => {
  it.effect("orders Goals as a person places them, and the boards show each Goal's place", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const boards = yield* Boards;
      const order = yield* GoalOrder;
      const sessions = yield* Sessions;
      const actions = yield* KanbanBoardActions;
      const first = yield* freshSession;
      const second = yield* freshSession;
      const projectId = (yield* sessions.get(first)).projectId;
      yield* workflows.updateGoal(first, goal);
      yield* workflows.updatePlan(first, plan(["a", "b"]), orchestrator);
      yield* workflows.updateGoal(second, goal);
      yield* workflows.updatePlan(second, plan(["x"]), orchestrator);
      const ranks = Effect.map(boards.list(projectId), (rows) =>
        Object.fromEntries(rows.map((row) => [row.sessionId, row.rank])),
      );

      // Nobody placed anything: both Goals are listed (made in the same instant, in either order).
      expect([...(yield* order.goals(projectId))].toSorted()).toEqual([first, second].toSorted());

      // A person puts one on top; the order survives its own reread and the boards show it.
      expect(yield* order.moveGoal(projectId, second, first)).toEqual([second, first]);
      expect(yield* order.goals(projectId)).toEqual([second, first]);
      expect(yield* ranks).toEqual({ [first]: 1, [second]: 0 });
      expect(yield* order.moveGoal(projectId, second, null)).toEqual([first, second]);
      expect(yield* ranks).toEqual({ [first]: 0, [second]: 1 });

      // Cards are ordered inside their own Plan only: another Plan's card is no place.
      const refused = yield* actions
        .applyIntent(first, BoardIntent.cases.Reorder.make({ cardId: "a", at: "x" }), user)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "KanbanActionRefused", reason: "card_missing" });
    }),
  );
});
