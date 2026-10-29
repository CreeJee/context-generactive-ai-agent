import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem, Layer, Option, Path, Scope } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  card,
  executingBoard,
  executingSession,
  git,
  kanbanFixture,
  kanbanOwner,
  scriptedAgent,
  type KanbanFixture,
} from "../testing/kanban.ts";
import { BoardEdit } from "../workflow/board-edit.ts";
import { BoardAuthor } from "../workflow/card.ts";
import { Workflows } from "../workflow/workflow.ts";
import { CardAttempts } from "./card-attempts.ts";
import { CardWorkspaceJanitor } from "./workspace-janitor.ts";
import { CardWorktrees } from "./worktree.ts";

type Owner = Layer.Success<ReturnType<typeof kanbanOwner>>;

// These tests run real git repositories and worktrees; beside other test files they pass 5s.
const gitTimeout = { timeout: 30_000 };

const withNode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
    Effect.provideContext(program, context),
  ).pipe(Effect.scoped);

/** An owner without board loops: nothing runs a card unless a test offers one. */
const openOwner = (fixture: KanbanFixture, scope: Scope.Scope) =>
  Effect.map(
    Layer.buildWithScope(kanbanOwner({ fixture, agent: scriptedAgent(() => Effect.never) }), scope),
    (context) =>
      <A, E>(effect: Effect.Effect<A, E, Owner>) =>
        Effect.provideContext(effect, context),
  );

const closePlan = Effect.fn("closePlan")(function* (sessionId: string) {
  const workflows = yield* Workflows;
  const planVersion = (yield* workflows.get(sessionId)).plan?.version ?? 0;
  yield* workflows.editBoard(
    sessionId,
    BoardEdit.cases.ClosePlan.make({ planVersion }),
    BoardAuthor.cases.User.make({}),
  );
});

const cardOf =
  (fixture: KanbanFixture, board: { readonly goalInstanceId: string }) => (cardId: string) => ({
    projectRoot: fixture.project,
    goalInstanceId: board.goalInstanceId,
    cardId,
  });

it.live(
  "settles a Goal that ended, keeping each card's work on its branch",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const run = yield* openOwner(fixture, yield* Effect.scope);
      yield* run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const worktrees = yield* CardWorktrees;
          const attempts = yield* CardAttempts;
          const janitor = yield* CardWorkspaceJanitor;
          const board = yield* executingBoard(fixture, [card("a"), card("b")]);
          const ref = cardOf(fixture, board);
          // a waits for a person with work nobody committed; b's attempt still holds its worktree.
          const a = yield* Effect.scoped(worktrees.lease(ref("a")));
          yield* fs.writeFileString(path.join(a.toolRoot, "draft.txt"), "draft\n");
          const attempt = yield* Scope.make();
          yield* worktrees.lease(ref("b")).pipe(Effect.provideService(Scope.Scope, attempt));

          yield* closePlan(board.sessionId);
          yield* attempts.stopGoal(board.goalInstanceId);
          yield* janitor.settleGoal(Option.getOrThrow(yield* attempts.goal(board.goalInstanceId)));
          expect(yield* worktrees.goalFolder(board.goalInstanceId)).toEqual({
            cardIds: ["b"],
            goalCheckout: false,
          });
          expect(
            yield* git(fixture.project, "show", `ctx/card/${board.goalInstanceId}/a:draft.txt`),
          ).toBe("draft");

          // The attempt ends: its delivery settles b, and the Goal's folder goes with it.
          yield* Scope.close(attempt, Exit.void);
          yield* janitor.settleDelivered(board.goalInstanceId, "b");
          expect(yield* fs.exists(path.join(fixture.worktrees, board.goalInstanceId))).toBe(false);
          expect(
            yield* git(fixture.project, "branch", "--list", `ctx/card/${board.goalInstanceId}/b`),
          ).not.toBe("");
        }),
      );
    }).pipe(withNode),
  gitTimeout,
);

it.live(
  "sweeps by reporting what nothing uses again, and deletes only when told to",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const run = yield* openOwner(fixture, yield* Effect.scope);
      yield* run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const worktrees = yield* CardWorktrees;
          const attempts = yield* CardAttempts;
          const janitor = yield* CardWorkspaceJanitor;
          // A Goal whose Plan closed while its owner was down.
          const ended = yield* executingBoard(fixture, [card("a")]);
          yield* Effect.scoped(worktrees.lease(cardOf(fixture, ended)("a")));
          yield* closePlan(ended.sessionId);
          yield* attempts.stopGoal(ended.goalInstanceId);
          // A running board: b is still on its Plan, `gone` was taken off it, and someone deleted
          // `lost`'s folder by hand.
          const running = yield* executingSession(ended.projectId, [card("b")]);
          yield* worktrees.prepareGoal({
            projectRoot: fixture.project,
            goalInstanceId: running.goalInstanceId,
          });
          yield* attempts.registerGoal({
            ...running,
            projectRoot: fixture.project,
            mode: "worktree",
            goalVersion: 1,
          });
          const ref = cardOf(fixture, running);
          yield* Effect.scoped(worktrees.lease(ref("b")));
          yield* Effect.scoped(worktrees.lease(ref("gone")));
          const lost = yield* Effect.scoped(worktrees.lease(ref("lost")));
          yield* fs.remove(lost.toolRoot, { recursive: true });
          // Another install shares the worktrees base.
          yield* fs.makeDirectory(path.join(fixture.worktrees, "other-goal", "card"), {
            recursive: true,
          });

          const listed = git(fixture.project, "worktree", "list", "--porcelain");
          const before = yield* listed;
          expect(yield* janitor.sweep("report")).toEqual({
            found: 7,
            orphaned: 4,
            cleaned: 0,
            skipped: 4,
          });
          expect(yield* listed).toBe(before);
          expect((yield* worktrees.goalFolder(ended.goalInstanceId)).cardIds).toEqual(["a"]);

          expect(yield* janitor.sweep("delete")).toEqual({
            found: 7,
            orphaned: 4,
            cleaned: 4,
            skipped: 4,
          });
          expect(yield* fs.exists(path.join(fixture.worktrees, ended.goalInstanceId))).toBe(false);
          expect(
            yield* git(fixture.project, "branch", "--list", `ctx/card/${ended.goalInstanceId}/a`),
          ).not.toBe("");
          const after = yield* listed;
          expect(after).not.toContain(ended.goalInstanceId);
          expect(after).not.toContain(`${running.goalInstanceId}/gone`);
          expect(after).not.toContain(`${running.goalInstanceId}/lost`);
          expect((yield* worktrees.goalFolder(running.goalInstanceId)).cardIds).toEqual(["b"]);
          expect((yield* worktrees.goalFolder("other-goal")).cardIds).toEqual(["card"]);
        }),
      );
    }).pipe(withNode),
  gitTimeout,
);
