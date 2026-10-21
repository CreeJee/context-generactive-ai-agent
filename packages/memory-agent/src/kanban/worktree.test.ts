import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { StorageRoot } from "../config/storage-root.ts";
import {
  canonicalPathEffect,
  resolveFencedOutsidePath,
  resolveProjectPath,
} from "../files/paths.ts";
import {
  CardIntegration,
  CardIntegrationConflict,
  cardToolProject,
  CardWorktreeFailedReason,
  cardWorktreeFailedReasonName,
  CardWorktrees,
  GoalSync,
  WorktreeDisposition,
  WorktreeSettlement,
} from "./worktree.ts";

/** Builds a layer in the test's scope and provides what it made. */
const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    spawner.string(ChildProcess.make("git", args, { cwd })),
  ).pipe(Effect.map((text) => text.trim()));

/** A user repository with one commit on `main`, plus a worktree base and storage root beside it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* canonicalPathEffect(yield* fs.makeTempDirectoryScoped());
  const project = path.join(home, "project");
  yield* fs.makeDirectory(project);
  yield* git(project, "init", "--quiet", "--initial-branch=main");
  yield* git(project, "config", "user.name", "Card Test");
  yield* git(project, "config", "user.email", "card@test.invalid");
  yield* git(project, "config", "commit.gpgsign", "false");
  yield* fs.writeFileString(path.join(project, "a.txt"), "one\n");
  yield* git(project, "add", "a.txt");
  yield* git(project, "commit", "--quiet", "-m", "start");
  const layer = CardWorktrees.layer(path.join(home, "worktrees")).pipe(
    Layer.provide(StorageRoot.layer(path.join(home, ".context-generactive-agent"))),
  );
  return { fs, path, home, project, layer };
});

/** The integration's tag, beside the failure reason's tag, in one list. */
const integrationName = CardIntegration.$match({
  Integrated: () => "Integrated" as const,
  AlreadyIntegrated: () => "AlreadyIntegrated" as const,
  NoChanges: () => "NoChanges" as const,
});

const run = <A, E>(
  program: (
    setup: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, CardWorktrees | NodeServices.NodeServices>,
) =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    return yield* provideLayer(setup.layer)(program(setup));
  }).pipe(provideLayer(NodeServices.layer), Effect.scoped);

it.live("asks for sequential execution when the project is not a git repository", () =>
  run(({ fs, path, home }) =>
    Effect.gen(function* () {
      const plain = path.join(home, "plain");
      yield* fs.makeDirectory(plain);
      const worktrees = yield* CardWorktrees;
      const failure = yield* Effect.flip(
        worktrees.prepareGoal({ projectRoot: plain, goalInstanceId: "g1" }),
      );
      expect(failure.reason).toEqual(
        CardWorktreeFailedReason.cases.SequentialRequired.make({ cause: "not_git_repository" }),
      );
    }),
  ),
);

it.live(
  "makes Goal and card branches without touching the user's checkout, and keeps or removes worktrees by outcome",
  () =>
    run(({ fs, path, home, project }) =>
      Effect.gen(function* () {
        const worktrees = yield* CardWorktrees;
        // The user is mid-edit on main; none of this may change.
        yield* fs.writeFileString(path.join(project, "a.txt"), "user edit\n");
        yield* fs.writeFileString(path.join(project, "untracked.txt"), "mine\n");
        const userStatus = yield* git(project, "status", "--porcelain");
        const userHead = yield* git(project, "rev-parse", "HEAD");

        const goal = yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g1" });
        expect(goal).toMatchObject({ branch: "ctx/goal/g1", head: userHead });
        const card = { projectRoot: project, goalInstanceId: "g1", cardId: "c1" };
        const cancelled = { ...card, cardId: "c2" };

        const leased = yield* Effect.scoped(
          Effect.gen(function* () {
            const worktree = yield* worktrees.lease(card);
            expect(worktree.path).toBe(path.join(home, "worktrees", "g1", "c1"));
            expect(yield* git(worktree.path, "branch", "--show-current")).toBe("ctx/card/g1/c1");
            expect(yield* fs.readFileString(path.join(worktree.path, "a.txt"))).toBe("one\n");
            expect((yield* Effect.flip(worktrees.lease(card))).reason).toEqual(
              CardWorktreeFailedReason.cases.InUse.make({}),
            );
            expect(
              (yield* Effect.flip(worktrees.settle(card, WorktreeDisposition.Done()))).reason,
            ).toEqual(CardWorktreeFailedReason.cases.InUse.make({}));
            yield* fs.writeFileString(path.join(worktree.path, "progress.txt"), "half\n");
            return worktree;
          }),
        );

        // Blocked keeps the worktree; the next attempt continues in it with the earlier files.
        expect(yield* worktrees.settle(card, WorktreeDisposition.Blocked())).toEqual(
          WorktreeSettlement.Retained(),
        );
        const again = yield* Effect.scoped(worktrees.lease(card));
        expect(again.path).toBe(leased.path);
        expect(yield* fs.readFileString(path.join(again.path, "progress.txt"))).toBe("half\n");
        expect(
          (yield* Effect.flip(worktrees.settle(card, WorktreeDisposition.Done()))).reason,
        ).toEqual(CardWorktreeFailedReason.cases.WorktreeDirty.make({}));
        yield* worktrees.commitWork(card, "progress");
        expect(yield* worktrees.settle(card, WorktreeDisposition.Done())).toEqual(
          WorktreeSettlement.Removed({ branchKept: false }),
        );
        expect(yield* fs.exists(leased.path)).toBe(false);
        expect(yield* git(project, "branch", "--list", "ctx/card/g1/c1")).toBe("");

        // Cancelled work stays recoverable on the card branch.
        const other = yield* Effect.scoped(worktrees.lease(cancelled));
        yield* fs.writeFileString(path.join(other.path, "draft.txt"), "draft\n");
        expect(yield* worktrees.settle(cancelled, WorktreeDisposition.Cancelled())).toEqual(
          WorktreeSettlement.Removed({ branchKept: true }),
        );
        expect(yield* fs.exists(other.path)).toBe(false);
        expect(yield* git(project, "show", "ctx/card/g1/c2:draft.txt")).toBe("draft");
        expect(yield* worktrees.find(cancelled)).toEqual(Option.none());

        expect(yield* git(project, "status", "--porcelain")).toBe(userStatus);
        expect(yield* git(project, "branch", "--show-current")).toBe("main");
        expect(yield* git(project, "rev-parse", "HEAD")).toBe(userHead);
      }),
    ),
);

it.live(
  "squashes cards into the Goal one at a time, merging an advanced Goal first and stopping on conflicts",
  () =>
    run(({ fs, path, project }) =>
      Effect.gen(function* () {
        const worktrees = yield* CardWorktrees;
        const goal = yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g2" });
        const card = (cardId: string) => ({ projectRoot: project, goalInstanceId: "g2", cardId });
        const edit = (cardId: string, file: string, text: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const worktree = yield* worktrees.lease(card(cardId));
              yield* fs.writeFileString(path.join(worktree.path, file), text);
              yield* worktrees.commitWork(card(cardId), `${cardId} work`);
            }),
          );
        yield* edit("a", "a.txt", "from a\n");
        yield* edit("b", "b.txt", "from b\n");
        yield* edit("c", "a.txt", "from c\n");

        // Both started from the same Goal HEAD; the owner lets one in and makes the other sync first.
        const results = yield* Effect.forEach(
          ["a", "b"],
          (id) =>
            worktrees.squashIntoGoal(card(id), `Card ${id}`).pipe(
              Effect.map((integration) => ({ id, integration: integrationName(integration) })),
              Effect.catchTag("CardWorktreeFailed", (failure) =>
                Effect.succeed({ id, integration: cardWorktreeFailedReasonName(failure.reason) }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        expect(results.map(({ integration }) => integration).sort()).toEqual([
          "GoalAdvanced",
          "Integrated",
        ]);
        const behind = results.find(({ integration }) => integration === "GoalAdvanced")?.id ?? "";
        expect(GoalSync.$is("Merged")(yield* worktrees.syncWithGoal(card(behind)))).toBe(true);
        expect(
          CardIntegration.$is("Integrated")(
            yield* worktrees.squashIntoGoal(card(behind), `Card ${behind}`),
          ),
        ).toBe(true);
        expect(
          CardIntegration.$is("AlreadyIntegrated")(
            yield* worktrees.squashIntoGoal(card("a"), "Card a"),
          ),
        ).toBe(true);

        // One squash commit per card, each with its own parent, ending in both cards' files.
        const history = yield* git(
          project,
          "log",
          "--format=%s|%(trailers:key=Ctx-Card,valueonly)",
          `${goal.head}..ctx/goal/g2`,
        );
        expect(
          history
            .split("\n")
            .filter((line) => line.length > 0)
            .sort(),
        ).toEqual(["Card a|g2/a", "Card b|g2/b"]);
        expect(yield* git(project, "show", "ctx/goal/g2:a.txt")).toBe("from a");
        expect(yield* git(project, "show", "ctx/goal/g2:b.txt")).toBe("from b");

        const conflict = yield* Effect.flip(worktrees.syncWithGoal(card("c")));
        expect(conflict).toBeInstanceOf(CardIntegrationConflict);
        expect(conflict).toMatchObject({ files: ["a.txt"] });
        const cWorktree = yield* worktrees.find(card("c"));
        expect(yield* git(Option.getOrThrow(cWorktree).path, "status", "--porcelain")).toBe("");
        expect(yield* git(project, "branch", "--show-current")).toBe("main");
      }),
    ),
);

it.live(
  "fixes a card's tools to its own worktree and refuses other worktrees, the user tree and storage",
  () =>
    run(({ fs, path, home, project }) =>
      Effect.gen(function* () {
        const worktrees = yield* CardWorktrees;
        yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g3" });
        const own = yield* worktrees.lease({
          projectRoot: project,
          goalInstanceId: "g3",
          cardId: "own",
        });
        const other = yield* worktrees.lease({
          projectRoot: project,
          goalInstanceId: "g3",
          cardId: "other",
        });
        const tools = cardToolProject({ id: "p", root: project }, own);
        const storage = path.join(home, ".context-generactive-agent");
        const notes = path.join(home, "notes");
        yield* fs.makeDirectory(notes);

        expect(tools.root).toBe(own.path);
        expect((yield* resolveProjectPath(tools.root, "a.txt", "file")).absolute).toBe(
          path.join(own.path, "a.txt"),
        );
        const outside = (target: string, kind: "file" | "directory" | "new-or-file") =>
          resolveFencedOutsidePath(tools.toolFence, tools.root, storage, target, kind).pipe(
            Effect.map(() => "allowed"),
            Effect.catchTag("PathRejected", (rejection) => Effect.succeed(rejection.reason)),
          );
        expect(
          yield* Effect.all([
            outside(path.join(other.path, "a.txt"), "file"),
            outside(path.join(project, "a.txt"), "file"),
            // A parent would list sibling worktrees.
            outside(path.join(home, "worktrees", "g3"), "directory"),
            outside(path.join(storage, "config.json"), "new-or-file"),
            outside(path.join(own.path, "a.txt"), "file"),
            outside(notes, "directory"),
          ]),
        ).toEqual([
          "outside_tool_root",
          "outside_tool_root",
          "outside_tool_root",
          "credential",
          "inside_project",
          "allowed",
        ]);
      }).pipe(Effect.scoped),
    ),
);
