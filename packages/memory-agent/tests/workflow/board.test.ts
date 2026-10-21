import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Boards } from "../../src/workflow/board.ts";
import type { CardStatus } from "../../src/workflow/card.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";
import { freshSession, testAgent, TestEnv } from "../support/test-env.ts";

const goal = {
  statement: "Run a Goal as a board",
  outcomes: ["Cards can be edited"],
  constraints: [],
  nonGoals: [],
  assumptions: [],
  openQuestions: [],
  status: "active" as const,
};

const step = (id: string, dependsOn: readonly string[] = []) => ({
  id,
  title: `Card ${id}`,
  description: id,
  dependsOn,
  acceptanceCriteria: [],
  ruleRefs: [],
});

const plan = {
  summary: "Board",
  steps: [step("a"), step("b", ["a"])],
  risks: [],
  openQuestions: [],
  status: "ready" as const,
};

const orchestrator = { _tag: "Orchestrator", runId: "run-1" } as const;
const user = { _tag: "User" } as const;

testAgent()("kanban board", (it) => {
  it.effect("reads Plans saved before cards as cards without rewriting them", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const legacy = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        phase: "execute",
        goal: { ...goal, version: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        plan: {
          version: 1,
          goalVersion: 1,
          summary: "Legacy",
          steps: [
            { ...step("a"), status: "pending" },
            { ...step("b", ["a"]), status: "pending" },
            { ...step("c"), status: "completed", evidence: ["done"] },
            { ...step("d", ["c"]), status: "pending" },
            { ...step("e"), status: "in_progress" },
            { ...step("f"), status: "blocked" },
          ],
          risks: [],
          openQuestions: [],
          status: "executing",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        ledger: [],
      });
      yield* sqlRun(
        "INSERT INTO session_workflows (session_id, state_json, updated_at) VALUES (?, ?, ?)",
        id,
        legacy,
        "2026-01-01T00:00:00.000Z",
      );

      const view = yield* (yield* Boards).view(id);
      expect(view.cards.map(({ card }) => [card.id, card.status])).toEqual([
        ["a", "ready"],
        ["b", "backlog"],
        ["c", "done"],
        ["d", "ready"],
        ["e", "in_progress"],
        ["f", "blocked"],
      ]);
      expect(
        yield* sqlGet("SELECT state_json FROM session_workflows WHERE session_id = ?", id),
      ).toEqual({ state_json: legacy });
    }),
  );

  it.effect("records who changed the board on each revision", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan, orchestrator);
      yield* workflows.editBoard(
        id,
        {
          _tag: "EditCard",
          planVersion: 1,
          cardId: "b",
          patch: { title: "Renamed", risk: "high" },
        },
        user,
      );

      expect(
        yield* sqlAll(
          `SELECT json_extract(author_json, '$._tag') AS tag, json_extract(author_json, '$.runId') AS run
             FROM workflow_state_revisions WHERE session_id = ? ORDER BY id`,
          id,
        ),
      ).toEqual([
        { tag: null, run: null },
        { tag: "Orchestrator", run: "run-1" },
        { tag: "User", run: null },
      ]);
      const view = yield* (yield* Boards).view(id);
      expect(view.history.map((revision) => [revision.author, revision.cardIds])).toEqual([
        [user, ["b"]],
        [orchestrator, ["a", "b"]],
      ]);
      expect(view.cards.map(({ card, lastChange }) => [card.title, lastChange?.author])).toEqual([
        ["Card a", orchestrator],
        ["Renamed", user],
      ]);
    }),
  );

  it.effect("stores a user change to an executing card as a request", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan);
      yield* workflows.setPhase(id, "execute");
      const executing = yield* workflows.updateProgress(id, {
        steps: [{ id: "a", status: "in_progress", evidence: [] }],
        goalEvidence: [],
        planEvidence: [],
        detail: "Started a",
      });

      const edit = yield* workflows.editBoard(
        id,
        { _tag: "EditCard", planVersion: 1, cardId: "a", patch: { title: "Changed" } },
        user,
      );
      expect(edit._tag).toBe("Requested");
      const view = yield* (yield* Boards).view(id);
      expect(view.plan?.version).toBe(1);
      expect(view.cards[0]?.card).toEqual(executing.plan?.steps[0]);
      expect(view.pendingChanges).toMatchObject([
        { cardId: "a", status: "pending", change: { _tag: "Edit", patch: { title: "Changed" } } },
      ]);
    }),
  );

  it.effect("moves card status with its author and refuses a stale or invalid move", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      yield* workflows.updatePlan(id, plan, orchestrator);
      const move = (cardId: string, from: CardStatus, to: CardStatus) =>
        workflows.transitionCard(id, { cardId, from, to }, orchestrator);

      yield* move("a", "ready", "in_progress");
      yield* move("a", "in_progress", "verify");
      const done = yield* move("a", "verify", "done");
      // b's dependency finished, so it is ready now; the Plan version is unchanged.
      expect(done.plan?.steps.map((step) => [step.id, step.status])).toEqual([
        ["a", "done"],
        ["b", "ready"],
      ]);
      expect(done.plan?.version).toBe(1);

      const refused = yield* Effect.forEach(
        [
          move("b", "backlog", "ready"),
          move("a", "done", "ready"),
          move("missing", "ready", "blocked"),
        ],
        Effect.flip,
      );
      expect(refused).toMatchObject(
        ["card_status_changed", "card_transition_invalid", "card_missing"].map((reason) => ({
          _tag: "BoardEditRefused",
          reason,
        })),
      );

      yield* workflows.transitionCard(
        id,
        { cardId: "b", from: "ready", to: "human_decision" },
        user,
      );
      const view = yield* (yield* Boards).view(id);
      expect(view.cards.map(({ card, lastChange }) => [card.status, lastChange?.author])).toEqual([
        ["done", orchestrator],
        ["human_decision", user],
      ]);
    }),
  );

  it.effect("refuses board changes that break dependsOn without saving them", () =>
    Effect.gen(function* () {
      const id = yield* freshSession;
      const workflows = yield* Workflows;
      yield* workflows.updateGoal(id, goal);
      const before = yield* workflows.updatePlan(id, plan);

      const unknown = yield* Effect.flip(
        workflows.editBoard(
          id,
          { _tag: "EditCard", planVersion: 1, cardId: "a", patch: { dependsOn: ["missing"] } },
          user,
        ),
      );
      const cycle = yield* Effect.flip(
        workflows.editBoard(
          id,
          { _tag: "EditCard", planVersion: 1, cardId: "a", patch: { dependsOn: ["b"] } },
          user,
        ),
      );
      const dependedOn = yield* Effect.flip(
        workflows.editBoard(id, { _tag: "CancelCard", planVersion: 1, cardId: "a" }, user),
      );
      expect([unknown, cycle, dependedOn]).toMatchObject([
        { _tag: "PlanDependenciesRejected", issues: [{ _tag: "UnknownDependency", stepId: "a" }] },
        { _tag: "PlanDependenciesRejected", issues: [{ _tag: "DependencyCycle" }] },
        {
          _tag: "PlanDependenciesRejected",
          issues: [{ _tag: "UnknownDependency", stepId: "b", dependsOn: "a" }],
        },
      ]);
      expect((yield* workflows.get(id)).plan).toEqual(before.plan);
    }),
  );

  it.effect("lists the project's boards: unarchived conversations with a Plan", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflows;
      const withPlan = yield* freshSession;
      yield* workflows.updateGoal(withPlan, goal);
      yield* workflows.updatePlan(withPlan, plan, orchestrator);
      yield* workflows.transitionCard(
        withPlan,
        { cardId: "a", from: "ready", to: "in_progress" },
        orchestrator,
      );
      const withoutPlan = yield* freshSession;
      yield* workflows.updateGoal(withoutPlan, goal);
      const archived = yield* freshSession;
      yield* workflows.updateGoal(archived, goal);
      yield* workflows.updatePlan(archived, plan, orchestrator);
      yield* sqlRun(
        "UPDATE sessions SET archived_at = ? WHERE id = ?",
        "2026-01-01T00:00:00.000Z",
        archived,
      );

      const boards = yield* (yield* Boards).list((yield* TestEnv).project.id);
      const ids = boards.map((board) => board.sessionId);
      expect(ids).toContain(withPlan);
      expect(ids).not.toContain(withoutPlan);
      expect(ids).not.toContain(archived);
      expect(boards.find((board) => board.sessionId === withPlan)).toMatchObject({
        plan: { version: 1, status: "ready", summary: "Board" },
        counts: { backlog: 1, ready: 0, in_progress: 1, verify: 0, done: 0, blocked: 0 },
        kanbanActive: false,
      });
    }),
  );
});
