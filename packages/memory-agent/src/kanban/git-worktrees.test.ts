import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, vi } from "vite-plus/test";
import { layer } from "@effect/vitest";
import { StorageRoot } from "../config/storage-root.ts";
import { resolveRootPath } from "../files/path-policy.ts";
import {
  canonicalPathEffect,
  resolveFencedOutsidePath,
  resolveProjectPath,
} from "../files/paths.ts";
import { KanbanTemplate, kanbanTestLayer } from "../testing/kanban.ts";
import {
  CardIntegration,
  CardIntegrationConflict,
  cardToolProject,
  CardWorktreeFailedReason,
  cardWorktreeFailedReasonName,
  CardWorktrees,
  GoalRetarget,
  GoalSync,
  WorktreeDisposition,
  WorktreeSettlement,
} from "./worktree.ts";
import { gitCardWorktreesLayer, worktreesBesideStorage } from "./git-worktrees.ts";

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
  yield* fs.copy((yield* KanbanTemplate).project, project);
  const worktreesLayer = gitCardWorktreesLayer(path.join(home, "worktrees")).pipe(
    Layer.provide(
      Layer.mergeAll(
        StorageRoot.layer(path.join(home, ".context-generactive-agent")),
        NodeCrypto.layer,
      ),
    ),
  );
  return { fs, path, home, project, worktreesLayer };
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
    return yield* provideLayer(setup.worktreesLayer)(program(setup));
  });

layer(kanbanTestLayer, { excludeTestServices: true })((it) => {
  it("keeps an app's card worktrees beside its own storage root", () => {
    expect(worktreesBesideStorage("/Users/me/.context-generactive-agent")).toBe(
      "/Users/me/.context-generactive-agent-worktrees",
    );
    // An app given its own storage never works in the default app's worktrees.
    expect(worktreesBesideStorage("/tmp/run/storage/")).toBe("/tmp/run/storage-worktrees");
  });

  it.effect("asks for sequential execution when the project is not a git repository", () =>
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

  it.effect(
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

          yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g1" });
          expect(yield* git(project, "rev-parse", "ctx/goal/g1")).toBe(userHead);
          const card = { projectRoot: project, goalInstanceId: "g1", cardId: "c1" };
          const cancelled = { ...card, cardId: "c2" };

          const leased = yield* Effect.scoped(
            Effect.gen(function* () {
              const worktree = yield* worktrees.lease(card);
              expect(worktree.toolRoot).toBe(path.join(home, "worktrees", "g1", "c1"));
              expect(yield* git(worktree.toolRoot, "branch", "--show-current")).toBe(
                "ctx/card/g1/c1",
              );
              expect(yield* fs.readFileString(path.join(worktree.toolRoot, "a.txt"))).toBe("one\n");
              expect((yield* Effect.flip(worktrees.lease(card))).reason).toEqual(
                CardWorktreeFailedReason.cases.InUse.make({}),
              );
              expect(
                (yield* Effect.flip(worktrees.settle(card, WorktreeDisposition.Done()))).reason,
              ).toEqual(CardWorktreeFailedReason.cases.InUse.make({}));
              yield* fs.writeFileString(path.join(worktree.toolRoot, "progress.txt"), "half\n");
              return worktree;
            }),
          );

          // Blocked keeps the worktree; the next attempt continues in it with the earlier files.
          expect(yield* worktrees.settle(card, WorktreeDisposition.Blocked())).toEqual(
            WorktreeSettlement.Retained(),
          );
          const again = yield* Effect.scoped(worktrees.lease(card));
          expect(again.toolRoot).toBe(leased.toolRoot);
          expect(yield* fs.readFileString(path.join(again.toolRoot, "progress.txt"))).toBe(
            "half\n",
          );
          // A finished card's uncommitted changes stay on its branch; a clean one's branch goes.
          expect(yield* worktrees.settle(card, WorktreeDisposition.Done())).toEqual(
            WorktreeSettlement.Removed({ branchKept: true }),
          );
          expect(yield* fs.exists(leased.toolRoot)).toBe(false);
          expect(yield* git(project, "show", "ctx/card/g1/c1:progress.txt")).toBe("half");
          const clean = { ...card, cardId: "c3" };
          yield* Effect.scoped(worktrees.lease(clean));
          expect(yield* worktrees.settle(clean, WorktreeDisposition.Done())).toEqual(
            WorktreeSettlement.Removed({ branchKept: false }),
          );
          expect(yield* git(project, "branch", "--list", "ctx/card/g1/c3")).toBe("");

          // Cancelled work stays recoverable on the card branch.
          const other = yield* Effect.scoped(worktrees.lease(cancelled));
          yield* fs.writeFileString(path.join(other.toolRoot, "draft.txt"), "draft\n");
          expect(yield* worktrees.settle(cancelled, WorktreeDisposition.Cancelled())).toEqual(
            WorktreeSettlement.Removed({ branchKept: true }),
          );
          expect(yield* fs.exists(other.toolRoot)).toBe(false);
          expect(yield* git(project, "show", "ctx/card/g1/c2:draft.txt")).toBe("draft");
          expect((yield* Effect.flip(worktrees.present(cancelled))).reason).toEqual(
            CardWorktreeFailedReason.cases.WorktreeMissing.make({}),
          );

          expect(yield* git(project, "status", "--porcelain")).toBe(userStatus);
          expect(yield* git(project, "branch", "--show-current")).toBe("main");
          expect(yield* git(project, "rev-parse", "HEAD")).toBe(userHead);
        }),
      ),
  );

  it.effect(
    "squashes cards into the Goal one at a time, merging an advanced Goal first and stopping on conflicts",
    () =>
      run(({ fs, path, project }) =>
        Effect.gen(function* () {
          const worktrees = yield* CardWorktrees;
          yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g2" });
          const card = (cardId: string) => ({ projectRoot: project, goalInstanceId: "g2", cardId });
          const edit = (cardId: string, file: string, text: string) =>
            Effect.scoped(
              Effect.gen(function* () {
                const worktree = yield* worktrees.lease(card(cardId));
                yield* fs.writeFileString(path.join(worktree.toolRoot, file), text);
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
          const behind =
            results.find(({ integration }) => integration === "GoalAdvanced")?.id ?? "";
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
            "main..ctx/goal/g2",
          );
          expect(
            history
              .split("\n")
              .filter((line) => line.length > 0)
              .sort(),
          ).toEqual(["Card a|g2/a", "Card b|g2/b"]);
          expect(yield* git(project, "show", "ctx/goal/g2:a.txt")).toBe("from a");
          expect(yield* git(project, "show", "ctx/goal/g2:b.txt")).toBe("from b");

          // A conflict stays in the card's worktree as an unfinished merge for the card to resolve.
          const conflict = yield* Effect.flip(worktrees.syncWithGoal(card("c")));
          expect(conflict).toBeInstanceOf(CardIntegrationConflict);
          expect(conflict).toMatchObject({ files: ["a.txt"] });
          const cWorktree = yield* worktrees.present(card("c"));
          expect((yield* git(cWorktree.toolRoot, "status", "--porcelain")).split("\n")).toEqual([
            "UU a.txt",
            "A  b.txt",
          ]);
          expect(yield* git(project, "branch", "--show-current")).toBe("main");

          // Nothing is committed while conflict markers remain; the resolved merge is committed as
          // the merge, and the card then joins the Goal.
          const unresolved = yield* Effect.flip(worktrees.commitWork(card("c"), "c resolves"));
          expect(cardWorktreeFailedReasonName(unresolved.reason)).toBe("ConflictUnresolved");
          yield* fs.writeFileString(path.join(cWorktree.toolRoot, "a.txt"), "from a and c\n");
          expect(Option.isSome(yield* worktrees.commitWork(card("c"), "c resolves"))).toBe(true);
          expect(
            (yield* git(cWorktree.toolRoot, "rev-list", "--parents", "-n", "1", "HEAD")).split(" "),
          ).toHaveLength(3);
          expect(
            CardIntegration.$is("Integrated")(yield* worktrees.squashIntoGoal(card("c"), "Card c")),
          ).toBe(true);
          expect(yield* git(project, "show", "ctx/goal/g2:a.txt")).toBe("from a and c");
        }),
      ),
  );

  it.effect(
    "moves an untouched Goal branch onto another user branch, and refuses once that would carry or drop work",
    () =>
      run(({ fs, path, project }) =>
        Effect.gen(function* () {
          const worktrees = yield* CardWorktrees;
          const goal = { projectRoot: project, goalInstanceId: "g3" };
          const card = { ...goal, cardId: "c1" };
          yield* worktrees.prepareGoal(goal);
          // After the board started, the user moved to another branch with work of its own.
          yield* git(project, "switch", "--quiet", "-c", "feature");
          yield* fs.writeFileString(path.join(project, "feature.txt"), "feature\n");
          yield* git(project, "add", "feature.txt");
          yield* git(project, "commit", "--quiet", "-m", "feature work");
          const featureHead = yield* git(project, "rev-parse", "HEAD");

          expect(yield* worktrees.retargetGoal(goal, "main", "feature")).toEqual(
            GoalRetarget.Moved({ head: featureHead }),
          );
          expect(yield* git(project, "rev-parse", "ctx/goal/g3")).toBe(featureHead);
          // A card started now has the new branch's work.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const worktree = yield* worktrees.lease(card);
              expect(yield* fs.readFileString(path.join(worktree.toolRoot, "feature.txt"))).toBe(
                "feature\n",
              );
              yield* fs.writeFileString(path.join(worktree.toolRoot, "card.txt"), "card\n");
            }),
          );
          yield* worktrees.commitWork(card, "c1 work");
          yield* worktrees.squashIntoGoal(card, "Card c1");
          const goalHead = yield* git(project, "rev-parse", "ctx/goal/g3");

          // The card branch started from the Goal head this would leave behind.
          expect(yield* worktrees.retargetGoal(goal, "feature", "main")).toEqual(
            GoalRetarget.CardsStarted({ branches: ["ctx/card/g3/c1"] }),
          );
          expect(yield* worktrees.settle(card, WorktreeDisposition.Done())).toEqual(
            WorktreeSettlement.Removed({ branchKept: false }),
          );
          // The card's squash commit is in neither user branch.
          expect(yield* worktrees.retargetGoal(goal, "feature", "main")).toEqual(
            GoalRetarget.GoalHasWork(),
          );
          expect(yield* git(project, "rev-parse", "ctx/goal/g3")).toBe(goalHead);
        }),
      ),
  );

  it.effect(
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

          expect(tools.root).toBe(own.toolRoot);
          expect((yield* resolveProjectPath(tools.root, "a.txt", "file")).absolute).toBe(
            path.join(own.toolRoot, "a.txt"),
          );
          // A path in the user's checkout means the same file in the card's own worktree.
          expect(
            (yield* resolveRootPath(tools, path.join(project, "a.txt"), "file")).absolute,
          ).toBe(path.join(own.toolRoot, "a.txt"));
          const outside = (target: string, kind: "file" | "directory" | "new-or-file") =>
            resolveFencedOutsidePath(tools.toolFence, tools.root, storage, target, kind).pipe(
              Effect.map(() => "allowed"),
              Effect.catchTag("PathRejected", (rejection) => Effect.succeed(rejection.reason)),
            );
          expect(
            yield* Effect.all([
              outside(path.join(other.toolRoot, "a.txt"), "file"),
              outside(path.join(project, "a.txt"), "file"),
              // A parent would list sibling worktrees.
              outside(path.join(home, "worktrees", "g3"), "directory"),
              outside(path.join(storage, "config.json"), "new-or-file"),
              outside(path.join(own.toolRoot, "a.txt"), "file"),
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

  it.effect(
    "installs a new card worktree's dependencies from its lockfile, preferring the local cache, and leases it even when that fails",
    () =>
      Effect.gen(function* () {
        const setup = yield* fixture;
        const { fs, path, home, project } = setup;
        // A stand-in pnpm on PATH records how it was called, and fails for card c2.
        const bin = path.join(home, "bin");
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(
          path.join(bin, "pnpm"),
          '#!/bin/sh\nmkdir -p node_modules && echo "$*" > node_modules/.installed\ncase "$PWD" in */c2) exit 1;; esac\n',
        );
        yield* fs.chmod(path.join(bin, "pnpm"), 0o755);
        const searched = yield* Config.String("PATH").pipe(Config.withDefault(""));
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("PATH", `${bin}:${searched}`)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
        yield* fs.writeFileString(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        yield* fs.writeFileString(path.join(project, ".gitignore"), "node_modules\n");
        yield* git(project, "add", "pnpm-lock.yaml", ".gitignore");
        yield* git(project, "commit", "-qm", "lockfile");
        yield* provideLayer(setup.worktreesLayer)(
          Effect.gen(function* () {
            const worktrees = yield* CardWorktrees;
            yield* worktrees.prepareGoal({ projectRoot: project, goalInstanceId: "g1" });
            const installed = yield* Effect.scoped(
              Effect.flatMap(
                worktrees.lease({ projectRoot: project, goalInstanceId: "g1", cardId: "c1" }),
                (worktree) =>
                  fs.readFileString(path.join(worktree.toolRoot, "node_modules", ".installed")),
              ),
            );
            expect(installed.trim()).toBe(
              "install --prefer-offline --frozen-lockfile --ignore-scripts",
            );
            const failed = yield* Effect.scoped(
              worktrees.lease({ projectRoot: project, goalInstanceId: "g1", cardId: "c2" }),
            );
            expect(yield* git(failed.toolRoot, "status", "--porcelain")).toBe("");
          }),
        );
      }),
  );

  it.effect("lets one check of a Goal hold the Goal checkout at a time", () =>
    run(({ fs, project }) =>
      Effect.gen(function* () {
        const worktrees = yield* CardWorktrees;
        const goal = { projectRoot: project, goalInstanceId: "g1" };
        yield* worktrees.prepareGoal(goal);
        const head = yield* git(project, "rev-parse", "ctx/goal/g1");
        const held = yield* Deferred.make<string>();
        const done = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const checkout = yield* worktrees.goalCheckout(goal, head);
              yield* Deferred.succeed(held, checkout.toolRoot);
              yield* Deferred.await(done);
              return yield* fs.exists(checkout.toolRoot);
            }),
          ),
        );
        const folder = yield* Deferred.await(held);
        // Without the hold, the second check would remove the first one's folder to make its own.
        const second = yield* Effect.forkChild(
          Effect.scoped(Effect.map(worktrees.goalCheckout(goal, head), (c) => c.toolRoot)),
        );
        yield* Effect.sleep("500 millis");
        expect(yield* fs.exists(folder)).toBe(true);
        yield* Deferred.succeed(done, undefined);
        expect(yield* Fiber.join(first)).toBe(true);
        expect(yield* Fiber.join(second)).toBe(folder);
      }),
    ),
  );
});
