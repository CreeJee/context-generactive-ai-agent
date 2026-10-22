import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { KanbanBoardActions } from "../../src/kanban/board-actions.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { Boards } from "../../src/workflow/board.ts";
import { BoardIntent } from "../../src/workflow/board-edit.ts";
import { BoardAuthor } from "../../src/workflow/card.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { freshSession, testAgent } from "../support/test-env.ts";

const goal = {
  statement: "Run a Goal as a board",
  outcomes: ["Cards are ordered across boards"],
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

testAgent()("card order across boards", (it) => {
  it.effect("ranks a card against another conversation's card and keeps each Plan's order", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const actions = yield* KanbanBoardActions;
      const boards = yield* Boards;
      const sessions = yield* Sessions;
      const first = yield* freshSession;
      const second = yield* freshSession;
      const projectId = (yield* sessions.get(first)).projectId;
      yield* workflows.updateGoal(first, goal);
      yield* workflows.updatePlan(first, plan(["a", "b"]), orchestrator);
      yield* workflows.updateGoal(second, goal);
      yield* workflows.updatePlan(second, plan(["x", "y"]), orchestrator);
      const ids = (sessionId: string) =>
        Effect.map(workflows.get(sessionId), (state) =>
          (state.plan?.steps ?? []).map((card) => card.id),
        );
      const ranks = Effect.map(boards.list(projectId), (rows) =>
        Object.fromEntries(rows.map((row) => [row.sessionId, row.ranks])),
      );
      const refused = (sessionId: string, intent: BoardIntent) =>
        actions.applyIntent(sessionId, intent, user).pipe(
          Effect.as(null),
          Effect.catchTag("KanbanActionRefused", (error) => Effect.succeed(error.reason)),
        );

      // Nothing arranged yet: the older conversation's cards come first.
      expect(yield* ranks).toEqual({ [first]: { a: 0, b: 1 }, [second]: { x: 2, y: 3 } });

      // a takes x's place: it now follows b in its own Plan, between x and y in the project.
      yield* actions.applyIntent(
        first,
        BoardIntent.cases.Reorder.make({ cardId: "a", at: "x", atSessionId: second }),
        user,
      );
      expect(yield* ids(first)).toEqual(["b", "a"]);
      expect(yield* ids(second)).toEqual(["x", "y"]);
      expect(yield* ranks).toEqual({ [first]: { b: 0, a: 2 }, [second]: { x: 1, y: 3 } });

      // Reordering inside one Plan moves the card there and keeps the other Plan where it was.
      yield* actions.applyIntent(
        first,
        BoardIntent.cases.Reorder.make({ cardId: "b", at: "a" }),
        user,
      );
      expect(yield* ids(first)).toEqual(["a", "b"]);
      expect(yield* ranks).toEqual({ [first]: { a: 1, b: 2 }, [second]: { x: 0, y: 3 } });

      // A card of another column, or of a conversation that is not on the board, is no place.
      yield* workflows.holdCard(second, { cardId: "y", hold: true }, user);
      expect(
        yield* refused(
          first,
          BoardIntent.cases.Reorder.make({ cardId: "a", at: "y", atSessionId: second }),
        ),
      ).toBe("reorder_across_columns");
      expect(
        yield* refused(
          first,
          BoardIntent.cases.Reorder.make({ cardId: "a", at: "x", atSessionId: "nowhere" }),
        ),
      ).toBe("card_missing");
    }),
  );
});
