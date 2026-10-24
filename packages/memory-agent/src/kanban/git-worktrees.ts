import {
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Match,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { StorageRoot } from "../config/storage-root.ts";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { canonicalPathEffect, pathsOverlap } from "../files/paths.ts";
import { findExecutable } from "../runtime/host.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { path as hostPath } from "../runtime/synchronous-path.ts";
import {
  CardIntegration,
  CardIntegrationConflict,
  CardWorktreeFailed,
  CardWorktreeFailedReason,
  CardWorktrees,
  GoalMergeConflict,
  GoalSync,
  TargetAdvance,
  TargetSync,
  WorktreeSettlement,
  type CardRef,
  type CardWorktree,
  type GoalRef,
  type WorktreeDisposition,
} from "./worktree.ts";

/**
 * {@link CardWorktrees} on git. A Goal gets the branch `ctx/goal/<goalInstanceId>` from the user's
 * current HEAD; each card gets `ctx/card/<goal>/<card>` checked out at
 * `<worktreesBase>/<goal>/<card>`. The user's work tree, index and branches are never touched:
 * branches are created by ref and the squash is written with `commit-tree`/`update-ref`.
 *
 * Every git call runs once. A call whose result cannot be known (interrupted mid-write) is not
 * repeated here; ref updates run uninterruptibly so their outcome is always observed.
 */

/** `~/.context-generactive-agent-worktrees`: outside the storage root, which is a credential directory. */
const defaultWorktreesBase = Effect.map(homeDirectory, (home) =>
  hostPath.join(home, ".context-generactive-agent-worktrees"),
);

/** Ids become path segments and branch names, so only plain names pass. */
const KanbanId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));

/** A card worktree as git knows it. */
interface GitWorktree {
  /** Repository top as git spells it. */
  readonly repository: string;
  readonly branch: string;
  /** The worktree folder (repository top of the checkout). */
  readonly path: string;
  /** Where the project sits inside the worktree. */
  readonly toolRoot: string;
  readonly worktreesBase: string;
}

/** The worktree as the card's tools see it: the user's checkout and every card worktree fenced off. */
const toolView = (projectRoot: string, worktree: GitWorktree): CardWorktree => ({
  toolRoot: worktree.toolRoot,
  deniedRoots: [projectRoot, worktree.repository, worktree.worktreesBase],
});

/** The folder, below the Goal's card worktrees, where the whole Goal branch is checked. */
const goalCheckoutFolder = ".goal";

type Operation = CardWorktreeFailed["operation"];
type Reason = CardWorktreeFailed["reason"];
const reasons = CardWorktreeFailedReason.cases;

interface GitOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

const goalBranchName = (goal: string) => `ctx/goal/${goal}`;
const cardBranchName = (goal: string, card: string) => `ctx/card/${goal}/${card}`;
const cardTrailer = (goal: string, card: string) => `Ctx-Card: ${goal}/${card}`;

const make = Effect.fnUntraced(function* (worktreesBase: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const storage = yield* StorageRoot;
  const git = yield* findExecutable("git");
  const serially = yield* keyedSerialLimit();
  const leases = yield* Ref.make(HashSet.empty<string>());

  const fail = (operation: Operation, reason: Reason, cause?: unknown) =>
    Effect.fail(CardWorktreeFailed.make({ operation, reason, cause }));

  /** One git process, scoped so interruption ends it. Exit codes are the caller's to read. */
  const run = (operation: Operation, cwd: string, args: ReadonlyArray<string>) =>
    git === null
      ? fail(operation, reasons.SequentialRequired.make({ cause: "git_unavailable" }))
      : Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(git, args, {
                cwd,
                // The user's own git identity and config apply; repository overrides never leak in.
                env: {
                  GIT_DIR: undefined,
                  GIT_WORK_TREE: undefined,
                  GIT_INDEX_FILE: undefined,
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
                extendEnv: true,
                windowsHide: true,
                stdin: "ignore",
                stderr: "ignore",
              }),
            );
            const [stdout, exitCode] = yield* Effect.all(
              [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
              { concurrency: 2 },
            );
            return { exitCode: Number(exitCode), stdout } satisfies GitOutput;
          }),
        ).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            fail(operation, reasons.GitFailed.make({ exitCode: null }), cause),
          ),
        );
  /** A git call that must succeed; its trimmed output. */
  const expect = (operation: Operation, cwd: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(run(operation, cwd, args), (output) =>
      output.exitCode === 0
        ? Effect.succeed(output.stdout.trim())
        : fail(operation, reasons.GitFailed.make({ exitCode: output.exitCode })),
    );
  /** A git question answered by exit code 0 or 1. */
  const answers = (operation: Operation, cwd: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(run(operation, cwd, args), (output) => {
      switch (output.exitCode) {
        case 0:
          return Effect.succeed(true);
        case 1:
          return Effect.succeed(false);
        default:
          return fail(operation, reasons.GitFailed.make({ exitCode: output.exitCode }));
      }
    });
  const revision = (operation: Operation, cwd: string, name: string) =>
    Effect.map(run(operation, cwd, ["rev-parse", "--verify", "--quiet", name]), (output) =>
      output.exitCode === 0 ? Option.some(output.stdout.trim()) : Option.none<string>(),
    );

  const checkIds = (operation: Operation, ids: ReadonlyArray<string>) =>
    Effect.forEach(ids, (id) =>
      Schema.decodeEffect(KanbanId)(id).pipe(
        Effect.mapError((cause) =>
          CardWorktreeFailed.make({ operation, reason: reasons.InvalidId.make({}), cause }),
        ),
      ),
    );

  /** The repository holding `projectRoot` and where the project sits inside it. */
  const repositoryOf = Effect.fnUntraced(function* (operation: Operation, projectRoot: string) {
    const top = yield* run(operation, projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ]);
    if (top.exitCode !== 0)
      return yield* fail(
        operation,
        reasons.SequentialRequired.make({ cause: "not_git_repository" }),
      );
    const repository = top.stdout.trim();
    const prefix = yield* expect(operation, projectRoot, ["rev-parse", "--show-prefix"]);
    const base = yield* canonicalPathEffect(worktreesBase).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({ operation, reason: reasons.UnsafeWorktreeBase.make({}), cause }),
      ),
    );
    if (pathsOverlap(base, repository) || pathsOverlap(base, storage.path))
      return yield* fail(operation, reasons.UnsafeWorktreeBase.make({}));
    return { repository, prefix, base };
  });

  const goalHead = (operation: Operation, repository: string, goal: string) =>
    Effect.flatMap(revision(operation, repository, `refs/heads/${goalBranchName(goal)}`), (head) =>
      Option.match(head, {
        onNone: () => fail(operation, reasons.GoalBranchMissing.make({})),
        onSome: Effect.succeed,
      }),
    );

  /** Registered worktree paths with the branch each has checked out. */
  const registered = (operation: Operation, repository: string) =>
    Effect.map(expect(operation, repository, ["worktree", "list", "--porcelain"]), (text) => {
      const entries: Array<{ readonly path: string; readonly branch: string | undefined }> = [];
      for (const block of text.split("\n\n")) {
        const fields = lines(block);
        const worktree = fields.find((line) => line.startsWith("worktree "));
        const branch = fields.find((line) => line.startsWith("branch "));
        if (worktree !== undefined)
          entries.push({
            path: worktree.slice("worktree ".length),
            branch: branch?.slice("branch refs/heads/".length),
          });
      }
      return entries;
    });

  const isClean = (operation: Operation, worktree: string) =>
    Effect.map(
      expect(operation, worktree, ["status", "--porcelain", "--untracked-files=all"]),
      (text) => text.length === 0,
    );

  const describe = Effect.fnUntraced(function* (operation: Operation, card: CardRef) {
    yield* checkIds(operation, [card.goalInstanceId, card.cardId]);
    const { repository, prefix, base } = yield* repositoryOf(operation, card.projectRoot);
    const folder = path.join(base, card.goalInstanceId, card.cardId);
    return {
      repository,
      branch: cardBranchName(card.goalInstanceId, card.cardId),
      path: folder,
      toolRoot: prefix.length === 0 ? folder : path.join(folder, prefix),
      worktreesBase: base,
    } satisfies GitWorktree;
  });

  /** The card's worktree as git knows it; none when it was never made or was removed. */
  const lookup = Effect.fnUntraced(function* (operation: Operation, card: CardRef) {
    const worktree = yield* describe(operation, card);
    const entry = (yield* registered(operation, worktree.repository)).find(
      (candidate) => candidate.path === worktree.path,
    );
    if (entry === undefined) return { worktree, state: "absent" as const };
    if (entry.branch !== worktree.branch)
      return yield* fail(operation, reasons.WorktreeOccupied.make({}));
    const present = yield* fs.exists(worktree.path).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({
          operation,
          reason: reasons.GitFailed.make({ exitCode: null }),
          cause,
        }),
      ),
    );
    return { worktree, state: present ? ("present" as const) : ("stale" as const) };
  });

  const ensure = Effect.fnUntraced(function* (card: CardRef) {
    const found = yield* lookup("lease", card);
    const { worktree } = found;
    switch (found.state) {
      case "present":
        return worktree;
      case "stale":
        // The folder was deleted by hand; forget it so git can check the branch out again.
        yield* expect("lease", worktree.repository, ["worktree", "prune"]);
        break;
      case "absent":
        break;
    }
    const occupied = yield* fs.exists(worktree.path).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({
          operation: "lease",
          reason: reasons.GitFailed.make({ exitCode: null }),
          cause,
        }),
      ),
    );
    if (occupied) return yield* fail("lease", reasons.WorktreeOccupied.make({}));
    yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({
          operation: "lease",
          reason: reasons.GitFailed.make({ exitCode: null }),
          cause,
        }),
      ),
    );
    const branch = yield* revision("lease", worktree.repository, `refs/heads/${worktree.branch}`);
    // A redelivered card continues on its existing branch; a new one starts from the Goal's HEAD.
    const args = Option.isSome(branch)
      ? ["worktree", "add", worktree.path, worktree.branch]
      : [
          "worktree",
          "add",
          "-b",
          worktree.branch,
          worktree.path,
          yield* goalHead("lease", worktree.repository, card.goalInstanceId),
        ];
    yield* expect("lease", worktree.repository, args).pipe(Effect.uninterruptible);
    return worktree;
  });

  /** Commits everything in the worktree to the card branch; none when there was nothing to commit. */
  const commitIn = Effect.fnUntraced(function* (
    operation: Operation,
    worktree: GitWorktree,
    message: string,
  ) {
    if (yield* isClean(operation, worktree.path)) return Option.none<string>();
    yield* expect(operation, worktree.path, ["add", "--all"]);
    // The card branch is internal; repository hooks run when the Goal reaches the user's branch.
    yield* expect(operation, worktree.path, [
      "commit",
      "--no-verify",
      "--quiet",
      "-m",
      message,
    ]).pipe(Effect.uninterruptible);
    return Option.some(yield* expect(operation, worktree.path, ["rev-parse", "HEAD"]));
  });

  const cardKey = (card: CardRef) => `card:${card.goalInstanceId}/${card.cardId}`;
  const goalKey = (goal: GoalRef) => `goal:${goal.goalInstanceId}`;

  const presentWorktree = (operation: Operation, card: CardRef) =>
    Effect.flatMap(lookup(operation, card), (found) =>
      found.state === "present"
        ? Effect.succeed(found.worktree)
        : fail(operation, reasons.WorktreeMissing.make({})),
    );

  return CardWorktrees.of({
    /** Only a ref is written; the user's checkout, index and current branch stay as they are. */
    prepareGoal: Effect.fn("CardWorktrees.prepareGoal")(function* (goal: GoalRef) {
      yield* checkIds("goal_branch", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("goal_branch", goal.projectRoot);
      const branch = goalBranchName(goal.goalInstanceId);
      yield* serially(
        goalKey(goal),
        Effect.gen(function* () {
          if (Option.isSome(yield* revision("goal_branch", repository, `refs/heads/${branch}`)))
            return;
          const head = yield* revision("goal_branch", goal.projectRoot, "HEAD^{commit}");
          if (Option.isNone(head))
            return yield* fail(
              "goal_branch",
              reasons.SequentialRequired.make({ cause: "no_commits" }),
            );
          yield* expect("goal_branch", repository, [
            "branch",
            "--no-track",
            branch,
            head.value,
          ]).pipe(Effect.uninterruptible);
        }),
      );
    }),

    lease: (card: CardRef) =>
      Effect.acquireRelease(
        serially(
          cardKey(card),
          Effect.gen(function* () {
            const key = cardKey(card);
            if (HashSet.has(yield* Ref.get(leases), key))
              return yield* fail("lease", reasons.InUse.make({}));
            const worktree = yield* ensure(card);
            yield* Ref.update(leases, HashSet.add(key));
            return worktree;
          }),
        ),
        () => Ref.update(leases, HashSet.remove(cardKey(card))),
      ).pipe(Effect.map((worktree) => toolView(card.projectRoot, worktree))),

    present: (card: CardRef) =>
      Effect.map(presentWorktree("lease", card), (worktree) =>
        toolView(card.projectRoot, worktree),
      ),

    settle: Effect.fn("CardWorktrees.settle")(function* (
      card: CardRef,
      disposition: WorktreeDisposition,
    ) {
      const retained = Effect.as(
        checkIds("settle", [card.goalInstanceId, card.cardId]),
        WorktreeSettlement.Retained(),
      );
      const remove = (keepBranch: boolean) =>
        serially(
          cardKey(card),
          Effect.gen(function* (): Effect.fn.Return<WorktreeSettlement, CardWorktreeFailed> {
            if (HashSet.has(yield* Ref.get(leases), cardKey(card)))
              return yield* fail("settle", reasons.InUse.make({}));
            const found = yield* lookup("settle", card);
            const { worktree } = found;
            switch (found.state) {
              case "present":
                if (keepBranch)
                  yield* commitIn("settle", worktree, `Cancelled card ${card.cardId} (snapshot)`);
                else if (!(yield* isClean("settle", worktree.path)))
                  return yield* fail("settle", reasons.WorktreeDirty.make({}));
                yield* expect("settle", worktree.repository, [
                  "worktree",
                  "remove",
                  worktree.path,
                ]).pipe(Effect.uninterruptible);
                break;
              case "stale":
                yield* expect("settle", worktree.repository, ["worktree", "prune"]);
                break;
              case "absent":
                break;
            }
            if (!keepBranch) {
              const branch = yield* revision(
                "settle",
                worktree.repository,
                `refs/heads/${worktree.branch}`,
              );
              if (Option.isSome(branch))
                yield* expect("settle", worktree.repository, [
                  "branch",
                  "-D",
                  worktree.branch,
                ]).pipe(Effect.uninterruptible);
            }
            return WorktreeSettlement.Removed({ branchKept: keepBranch });
          }),
        );
      return yield* Match.valueTags(disposition, {
        Blocked: () => retained,
        HumanDecision: () => retained,
        Done: () => remove(false),
        Cancelled: () => remove(true),
      });
    }),

    commitWork: Effect.fn("CardWorktrees.commitWork")(function* (card: CardRef, message: string) {
      return yield* serially(
        cardKey(card),
        Effect.flatMap(presentWorktree("commit", card), (worktree) =>
          commitIn("commit", worktree, message),
        ),
      );
    }),

    /** The Goal branch comes in with a merge commit; a conflicted merge is aborted. */
    syncWithGoal: Effect.fn("CardWorktrees.syncWithGoal")(function* (card: CardRef) {
      return yield* serially(
        goalKey(card),
        serially(
          cardKey(card),
          Effect.gen(function* (): Effect.fn.Return<
            GoalSync,
            CardWorktreeFailed | CardIntegrationConflict
          > {
            const worktree = yield* presentWorktree("sync", card);
            if (!(yield* isClean("sync", worktree.path)))
              return yield* fail("sync", reasons.WorktreeDirty.make({}));
            const head = yield* goalHead("sync", worktree.repository, card.goalInstanceId);
            if (
              yield* answers("sync", worktree.path, ["merge-base", "--is-ancestor", head, "HEAD"])
            )
              return GoalSync.UpToDate();
            const merged = yield* run("sync", worktree.path, [
              "merge",
              "--no-ff",
              "--no-edit",
              "--no-verify",
              "-m",
              `Merge ${goalBranchName(card.goalInstanceId)} into card ${card.cardId}`,
              head,
            ]).pipe(Effect.uninterruptible);
            if (merged.exitCode === 0)
              return GoalSync.Merged({
                head: yield* expect("sync", worktree.path, ["rev-parse", "HEAD"]),
              });
            const files = lines(
              yield* expect("sync", worktree.path, ["diff", "--name-only", "--diff-filter=U"]),
            );
            yield* expect("sync", worktree.path, ["merge", "--abort"]).pipe(Effect.uninterruptible);
            return yield* files.length === 0
              ? fail("sync", reasons.GitFailed.make({ exitCode: merged.exitCode }))
              : Effect.fail(
                  CardIntegrationConflict.make({
                    goalInstanceId: card.goalInstanceId,
                    cardId: card.cardId,
                    files,
                  }),
                );
          }),
        ),
      );
    }),

    /**
     * One squash commit whose tree is the card branch's, carrying the card's trailer. The ref moves
     * only from the HEAD that was read.
     */
    squashIntoGoal: Effect.fn("CardWorktrees.squashIntoGoal")(function* (
      card: CardRef,
      title: string,
    ) {
      return yield* serially(
        goalKey(card),
        serially(
          cardKey(card),
          Effect.gen(function* (): Effect.fn.Return<CardIntegration, CardWorktreeFailed> {
            const worktree = yield* presentWorktree("squash", card);
            const trailer = cardTrailer(card.goalInstanceId, card.cardId);
            const goalBranch = `refs/heads/${goalBranchName(card.goalInstanceId)}`;
            const head = yield* goalHead("squash", worktree.repository, card.goalInstanceId);
            const earlier = lines(
              yield* expect("squash", worktree.repository, [
                "log",
                "--format=%H",
                // Ids are plain names, so the anchored trailer is a literal line.
                `--grep=^${trailer}$`,
                head,
              ]),
            )[0];
            if (earlier !== undefined)
              return CardIntegration.AlreadyIntegrated({ commit: earlier });
            if (!(yield* isClean("squash", worktree.path)))
              return yield* fail("squash", reasons.WorktreeDirty.make({}));
            if (
              !(yield* answers("squash", worktree.path, [
                "merge-base",
                "--is-ancestor",
                head,
                "HEAD",
              ]))
            )
              return yield* fail("squash", reasons.GoalAdvanced.make({}));
            const tree = yield* expect("squash", worktree.path, ["rev-parse", "HEAD^{tree}"]);
            if (
              tree ===
              (yield* expect("squash", worktree.repository, ["rev-parse", `${head}^{tree}`]))
            )
              return CardIntegration.NoChanges();
            const commit = yield* expect("squash", worktree.repository, [
              "commit-tree",
              tree,
              "-p",
              head,
              "-m",
              title,
              "-m",
              trailer,
            ]);
            yield* expect("squash", worktree.repository, [
              "update-ref",
              "-m",
              `ctx: integrate card ${card.cardId}`,
              goalBranch,
              commit,
              head,
            ]).pipe(Effect.uninterruptible);
            return CardIntegration.Integrated({ commit });
          }),
        ),
      );
    }),

    /** Cancelled and conflicting cards keep their branch; git can read it from any worktree. */
    earlierWork: (card: CardRef) =>
      `Its work is on branch ${cardBranchName(card.goalInstanceId, card.cardId)}; read it with read-only git commands (git diff, git show).`,

    currentBranch: Effect.fn("CardWorktrees.currentBranch")(function* (projectRoot: string) {
      const output = yield* run("goal_branch", projectRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return output.exitCode === 0 ? Option.some(output.stdout.trim()) : Option.none<string>();
    }),

    goalHead: Effect.fn("CardWorktrees.goalHead")(function* (goal: GoalRef) {
      yield* checkIds("goal_merge", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("goal_merge", goal.projectRoot);
      return yield* goalHead("goal_merge", repository, goal.goalInstanceId);
    }),

    /**
     * The merge commit is written by `merge-tree` and `commit-tree`, so no checkout is touched.
     * Integrations of the same Goal wait for it, and the ref moves only from the HEAD that was read.
     */
    mergeTargetIntoGoal: Effect.fn("CardWorktrees.mergeTargetIntoGoal")(function* (
      goal: GoalRef,
      target: string,
    ) {
      yield* checkIds("goal_merge", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("goal_merge", goal.projectRoot);
      return yield* serially(
        goalKey(goal),
        Effect.gen(function* (): Effect.fn.Return<
          TargetSync,
          CardWorktreeFailed | GoalMergeConflict
        > {
          const targetHead = yield* revision("goal_merge", repository, `refs/heads/${target}`);
          if (Option.isNone(targetHead))
            return yield* fail("goal_merge", reasons.TargetMissing.make({}));
          const head = yield* goalHead("goal_merge", repository, goal.goalInstanceId);
          if (
            yield* answers("goal_merge", repository, [
              "merge-base",
              "--is-ancestor",
              targetHead.value,
              head,
            ])
          )
            return TargetSync.UpToDate({ head });
          const merged = yield* run("goal_merge", repository, [
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            head,
            targetHead.value,
          ]);
          const [tree = "", ...conflicted] = lines(merged.stdout);
          switch (merged.exitCode) {
            case 0:
              break;
            case 1:
              return yield* GoalMergeConflict.make({
                goalInstanceId: goal.goalInstanceId,
                targetBranch: target,
                goalHead: head,
                targetHead: targetHead.value,
                files: conflicted,
              });
            default:
              return yield* fail(
                "goal_merge",
                reasons.GitFailed.make({ exitCode: merged.exitCode }),
              );
          }
          const commit = yield* expect("goal_merge", repository, [
            "commit-tree",
            tree,
            "-p",
            head,
            "-p",
            targetHead.value,
            "-m",
            `Merge ${target} into ${goalBranchName(goal.goalInstanceId)}`,
          ]);
          yield* expect("goal_merge", repository, [
            "update-ref",
            "-m",
            `ctx: take in ${target}`,
            `refs/heads/${goalBranchName(goal.goalInstanceId)}`,
            commit,
            head,
          ]).pipe(Effect.uninterruptible);
          const files = lines(
            yield* expect("goal_merge", repository, ["diff", "--name-only", head, commit]),
          );
          return TargetSync.Merged({ from: head, head: commit, files });
        }),
      );
    }),

    /**
     * A branch checked out somewhere moves only through that checkout's own fast-forward, and never
     * while it has uncommitted changes to tracked files; git also refuses to overwrite untracked
     * ones. Elsewhere the ref moves only from the commit that was read.
     */
    advanceTarget: Effect.fn("CardWorktrees.advanceTarget")(function* (
      goal: GoalRef,
      target: string,
      head: string,
    ) {
      const { repository } = yield* repositoryOf("goal_merge", goal.projectRoot);
      return yield* serially(
        `target:${repository}:${target}`,
        Effect.gen(function* (): Effect.fn.Return<TargetAdvance, CardWorktreeFailed> {
          const read = revision("goal_merge", repository, `refs/heads/${target}`);
          const before = yield* read;
          if (Option.isNone(before))
            return yield* fail("goal_merge", reasons.TargetMissing.make({}));
          if (before.value === head) return TargetAdvance.Advanced({ commit: head });
          if (
            !(yield* answers("goal_merge", repository, [
              "merge-base",
              "--is-ancestor",
              before.value,
              head,
            ]))
          )
            return TargetAdvance.TargetMoved();
          const checkout = (yield* registered("goal_merge", repository)).find(
            (entry) => entry.branch === target,
          );
          if (checkout === undefined) {
            const moved = yield* run("goal_merge", repository, [
              "update-ref",
              "-m",
              `ctx: merge ${goalBranchName(goal.goalInstanceId)}`,
              `refs/heads/${target}`,
              head,
              before.value,
            ]).pipe(Effect.uninterruptible);
            return moved.exitCode === 0
              ? TargetAdvance.Advanced({ commit: head })
              : TargetAdvance.TargetMoved();
          }
          const changes = yield* expect("goal_merge", checkout.path, [
            "status",
            "--porcelain",
            "--untracked-files=no",
          ]);
          if (changes.length > 0) return TargetAdvance.WorktreeBusy({ worktree: checkout.path });
          const moved = yield* run("goal_merge", checkout.path, [
            "merge",
            "--ff-only",
            "--quiet",
            head,
          ]).pipe(Effect.uninterruptible);
          if (moved.exitCode === 0) return TargetAdvance.Advanced({ commit: head });
          const after = yield* read;
          return Option.contains(after, before.value)
            ? TargetAdvance.WorktreeBusy({ worktree: checkout.path })
            : TargetAdvance.TargetMoved();
        }),
      );
    }),

    /** A detached worktree; a checkout a crash left behind is removed first. */
    goalCheckout: (goal: GoalRef, head: string) =>
      Effect.acquireRelease(
        serially(
          `checkout:${goal.goalInstanceId}`,
          Effect.gen(function* () {
            yield* checkIds("checkout", [goal.goalInstanceId]);
            const { repository, prefix, base } = yield* repositoryOf("checkout", goal.projectRoot);
            const folder = path.join(base, goal.goalInstanceId, goalCheckoutFolder);
            if ((yield* registered("checkout", repository)).some((entry) => entry.path === folder))
              yield* expect("checkout", repository, ["worktree", "remove", "--force", folder]);
            yield* expect("checkout", repository, ["worktree", "prune"]);
            yield* fs.remove(folder, { recursive: true, force: true }).pipe(
              Effect.mapError((cause) =>
                CardWorktreeFailed.make({
                  operation: "checkout",
                  reason: reasons.GitFailed.make({ exitCode: null }),
                  cause,
                }),
              ),
            );
            yield* fs.makeDirectory(path.dirname(folder), { recursive: true, mode: 0o700 }).pipe(
              Effect.mapError((cause) =>
                CardWorktreeFailed.make({
                  operation: "checkout",
                  reason: reasons.GitFailed.make({ exitCode: null }),
                  cause,
                }),
              ),
            );
            yield* expect("checkout", repository, ["worktree", "add", "--detach", folder, head]);
            return {
              repository,
              branch: goalBranchName(goal.goalInstanceId),
              path: folder,
              toolRoot: prefix.length === 0 ? folder : path.join(folder, prefix),
              worktreesBase: base,
            } satisfies GitWorktree;
          }),
        ),
        (checkout) =>
          expect("checkout", checkout.repository, [
            "worktree",
            "remove",
            "--force",
            checkout.path,
          ]).pipe(
            Effect.catchTag("CardWorktreeFailed", (failure) =>
              Effect.logWarning("Goal checkout was not removed", { reason: failure.reason }),
            ),
          ),
      ).pipe(Effect.map((checkout) => toolView(goal.projectRoot, checkout))),

    /** The Goal branch goes to `origin` under its own name. */
    pushGoalBranch: Effect.fn("CardWorktrees.pushGoalBranch")(function* (goal: GoalRef) {
      yield* checkIds("push", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("push", goal.projectRoot);
      const branch = goalBranchName(goal.goalInstanceId);
      const ref = `refs/heads/${branch}`;
      const pushed = yield* run("push", repository, ["push", "origin", `${ref}:${ref}`]).pipe(
        Effect.uninterruptible,
      );
      return pushed.exitCode === 0 ? Option.some(branch) : Option.none<string>();
    }),
  });
});

/** {@link CardWorktrees} on git, with card worktrees below `worktreesBase`. */
export const gitCardWorktreesLayer = (worktreesBase?: string) =>
  Layer.effect(
    CardWorktrees,
    Effect.flatMap(
      worktreesBase === undefined ? defaultWorktreesBase : Effect.succeed(worktreesBase),
      make,
    ),
  );
