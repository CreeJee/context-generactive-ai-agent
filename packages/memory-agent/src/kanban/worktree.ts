import {
  Context,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Function as EffectFunction } from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { StorageRoot } from "../config/storage-root.ts";
import { keyedSerialLimit } from "../concurrency/keyed-limit.ts";
import { canonicalPathEffect, pathsOverlap, type Fenced } from "../files/paths.ts";
import { findExecutable } from "../runtime/host.ts";
import { homeDirectory } from "../runtime/host-system.ts";
import { path as hostPath } from "../runtime/synchronous-path.ts";

/**
 * Card worktrees (docs/kanban-orchestration.md "실행", "브랜치 흐름"). A Goal gets the branch
 * `ctx/goal/<goalInstanceId>` from the user's current HEAD; each card gets `ctx/card/<goal>/<card>`
 * checked out at `<worktreesBase>/<goal>/<card>`. The user's work tree, index and branches are never
 * touched: branches are created by ref and the squash is written with `commit-tree`/`update-ref`.
 *
 * Every git call runs once. A call whose result cannot be known (interrupted mid-write) is not
 * repeated here; ref updates run uninterruptibly so their outcome is always observed.
 */

/** `~/.context-generactive-agent-worktrees`: outside the storage root, which is a credential directory. */
export const defaultWorktreesBase = Effect.map(homeDirectory, (home) =>
  hostPath.join(home, ".context-generactive-agent-worktrees"),
);

/** Ids become path segments and branch names, so only plain names pass. */
export const KanbanId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/));

export interface GoalRef {
  /** The project folder the Goal runs for; it may be below the repository top. */
  readonly projectRoot: string;
  readonly goalInstanceId: string;
}

export interface CardRef extends GoalRef {
  readonly cardId: string;
}

export interface GoalBranch {
  /** Repository top as git spells it. */
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
}

export interface CardWorktree {
  readonly goalInstanceId: string;
  readonly cardId: string;
  readonly repository: string;
  readonly branch: string;
  /** The worktree folder (repository top of the checkout). */
  readonly path: string;
  /** Where the project sits inside the worktree; the card's file and shell tools start here. */
  readonly toolRoot: string;
  readonly worktreesBase: string;
}

/**
 * What happens to a card worktree once the card leaves execution. `Done` work is in the Goal
 * branch, so the worktree and card branch go. `Cancelled` work is committed to the card branch as a
 * snapshot before the worktree goes, so it stays recoverable. `Blocked` and `HumanDecision` keep
 * the worktree for the next attempt or for the person deciding.
 */
export type WorktreeDisposition =
  | { readonly _tag: "Done" }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "HumanDecision" };

export type WorktreeSettlement =
  | { readonly _tag: "Removed"; readonly branchKept: boolean }
  | { readonly _tag: "Retained" };

export type GoalSync =
  | { readonly _tag: "UpToDate" }
  | { readonly _tag: "Merged"; readonly head: string };

export type CardIntegration =
  | { readonly _tag: "Integrated"; readonly commit: string }
  | { readonly _tag: "AlreadyIntegrated"; readonly commit: string }
  | { readonly _tag: "NoChanges" };

/** The user's branch taken into the Goal branch. */
export type TargetSync =
  | { readonly _tag: "UpToDate"; readonly head: string }
  /** `files` changed between the Goal branch at `from` and the merge commit `head`. */
  | {
      readonly _tag: "Merged";
      readonly from: string;
      readonly head: string;
      readonly files: readonly string[];
    };

/** Moving the user's branch to the Goal branch head. */
export type TargetAdvance =
  | { readonly _tag: "Advanced"; readonly commit: string }
  /** The branch moved past what the Goal branch contains; take it in and check again. */
  | { readonly _tag: "TargetMoved" }
  /** The branch is checked out with uncommitted changes, or the checkout refused to move. */
  | { readonly _tag: "WorktreeBusy"; readonly worktree: string };

/**
 * The project as a card's tools see it: rooted at the card worktree, with the user's checkout and
 * every card worktree fenced off from the outside tools. Credential and storage-root refusals are
 * unchanged; this only narrows.
 */
export const cardToolProject: {
  (worktree: CardWorktree): <P extends { readonly root: string }>(project: P) => Fenced<P>;
  <P extends { readonly root: string }>(project: P, worktree: CardWorktree): Fenced<P>;
} = EffectFunction.dual(
  2,
  <P extends { readonly root: string }>(project: P, worktree: CardWorktree): Fenced<P> => ({
    ...project,
    root: worktree.toolRoot,
    toolFence: { deniedRoots: [project.root, worktree.repository, worktree.worktreesBase] },
  }),
);

const SequentialCause = Schema.Literals(["git_unavailable", "not_git_repository", "no_commits"]);

export class CardWorktreeFailed extends Schema.TaggedError<CardWorktreeFailed>()(
  "CardWorktreeFailed",
  {
    operation: Schema.Literals([
      "goal_branch",
      "lease",
      "settle",
      "commit",
      "sync",
      "squash",
      "goal_merge",
      "checkout",
      "push",
    ]),
    reason: Schema.Union([
      /** No worktree can exist here: run the Goal's cards one after another instead. */
      Schema.TaggedStruct("SequentialRequired", { cause: SequentialCause }),
      Schema.TaggedStruct("InvalidId", {}),
      /** The worktree base would sit inside the project or the storage root. */
      Schema.TaggedStruct("UnsafeWorktreeBase", {}),
      Schema.TaggedStruct("GoalBranchMissing", {}),
      /** Something other than this card's worktree occupies its folder. */
      Schema.TaggedStruct("WorktreeOccupied", {}),
      Schema.TaggedStruct("WorktreeMissing", {}),
      Schema.TaggedStruct("WorktreeDirty", {}),
      /** An attempt still holds the worktree. */
      Schema.TaggedStruct("InUse", {}),
      /** The Goal branch moved past the card branch; sync the card first and verify again. */
      Schema.TaggedStruct("GoalAdvanced", {}),
      /** The branch the Goal merges into no longer exists. */
      Schema.TaggedStruct("TargetMissing", {}),
      Schema.TaggedStruct("GitFailed", { exitCode: Schema.NullOr(Schema.Finite) }),
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Merging the Goal branch into the card stopped on conflicts; nothing was resolved automatically. */
export class CardIntegrationConflict extends Schema.TaggedError<CardIntegrationConflict>()(
  "CardIntegrationConflict",
  {
    goalInstanceId: Schema.String,
    cardId: Schema.String,
    files: Schema.Array(Schema.String),
  },
) {}

/** Taking the user's branch into the Goal branch stopped on conflicts; nothing was written. */
export class GoalMergeConflict extends Schema.TaggedError<GoalMergeConflict>()(
  "GoalMergeConflict",
  {
    goalInstanceId: Schema.String,
    targetBranch: Schema.String,
    goalHead: Schema.String,
    targetHead: Schema.String,
    files: Schema.Array(Schema.String),
  },
) {}

/** The folder, below the Goal's card worktrees, where the whole Goal branch is checked. */
const goalCheckoutFolder = ".goal";

type Operation = CardWorktreeFailed["operation"];
type Reason = CardWorktreeFailed["reason"];

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
      ? fail(operation, { _tag: "SequentialRequired", cause: "git_unavailable" })
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
            fail(operation, { _tag: "GitFailed", exitCode: null }, cause),
          ),
        );
  /** A git call that must succeed; its trimmed output. */
  const expect = (operation: Operation, cwd: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(run(operation, cwd, args), (output) =>
      output.exitCode === 0
        ? Effect.succeed(output.stdout.trim())
        : fail(operation, { _tag: "GitFailed", exitCode: output.exitCode }),
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
          return fail(operation, { _tag: "GitFailed", exitCode: output.exitCode });
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
          CardWorktreeFailed.make({ operation, reason: { _tag: "InvalidId" }, cause }),
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
      return yield* fail(operation, { _tag: "SequentialRequired", cause: "not_git_repository" });
    const repository = top.stdout.trim();
    const prefix = yield* expect(operation, projectRoot, ["rev-parse", "--show-prefix"]);
    const base = yield* canonicalPathEffect(worktreesBase).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({ operation, reason: { _tag: "UnsafeWorktreeBase" }, cause }),
      ),
    );
    if (pathsOverlap(base, repository) || pathsOverlap(base, storage.path))
      return yield* fail(operation, { _tag: "UnsafeWorktreeBase" });
    return { repository, prefix, base };
  });

  const goalHead = (operation: Operation, repository: string, goal: string) =>
    Effect.flatMap(revision(operation, repository, `refs/heads/${goalBranchName(goal)}`), (head) =>
      Option.match(head, {
        onNone: () => fail(operation, { _tag: "GoalBranchMissing" }),
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
      goalInstanceId: card.goalInstanceId,
      cardId: card.cardId,
      repository,
      branch: cardBranchName(card.goalInstanceId, card.cardId),
      path: folder,
      toolRoot: prefix.length === 0 ? folder : path.join(folder, prefix),
      worktreesBase: base,
    } satisfies CardWorktree;
  });

  /** The card's worktree as git knows it; none when it was never made or was removed. */
  const lookup = Effect.fnUntraced(function* (operation: Operation, card: CardRef) {
    const worktree = yield* describe(operation, card);
    const entry = (yield* registered(operation, worktree.repository)).find(
      (candidate) => candidate.path === worktree.path,
    );
    if (entry === undefined) return { worktree, state: "absent" as const };
    if (entry.branch !== worktree.branch)
      return yield* fail(operation, { _tag: "WorktreeOccupied" });
    const present = yield* fs.exists(worktree.path).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({
          operation,
          reason: { _tag: "GitFailed", exitCode: null },
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
          reason: { _tag: "GitFailed", exitCode: null },
          cause,
        }),
      ),
    );
    if (occupied) return yield* fail("lease", { _tag: "WorktreeOccupied" });
    yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError((cause) =>
        CardWorktreeFailed.make({
          operation: "lease",
          reason: { _tag: "GitFailed", exitCode: null },
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
    worktree: CardWorktree,
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
        : fail(operation, { _tag: "WorktreeMissing" }),
    );

  return {
    /**
     * Creates `ctx/goal/<goalInstanceId>` at the user's current HEAD unless it exists. Only a ref is
     * written; the user's checkout, index and current branch stay as they are.
     */
    prepareGoal: Effect.fn("CardWorktrees.prepareGoal")(function* (goal: GoalRef) {
      yield* checkIds("goal_branch", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("goal_branch", goal.projectRoot);
      const branch = goalBranchName(goal.goalInstanceId);
      return yield* serially(
        goalKey(goal),
        Effect.gen(function* () {
          const existing = yield* revision("goal_branch", repository, `refs/heads/${branch}`);
          if (Option.isSome(existing))
            return { repository, branch, head: existing.value } satisfies GoalBranch;
          const head = yield* revision("goal_branch", goal.projectRoot, "HEAD^{commit}");
          if (Option.isNone(head))
            return yield* fail("goal_branch", { _tag: "SequentialRequired", cause: "no_commits" });
          yield* expect("goal_branch", repository, [
            "branch",
            "--no-track",
            branch,
            head.value,
          ]).pipe(Effect.uninterruptible);
          return { repository, branch, head: head.value } satisfies GoalBranch;
        }),
      );
    }),

    /**
     * The card's worktree for one attempt: made from the Goal branch HEAD, or the existing one when
     * the card continues. While the scope is open nothing settles the worktree away.
     */
    lease: (card: CardRef): Effect.Effect<CardWorktree, CardWorktreeFailed, Scope.Scope> =>
      Effect.acquireRelease(
        serially(
          cardKey(card),
          Effect.gen(function* () {
            const key = cardKey(card);
            if (HashSet.has(yield* Ref.get(leases), key))
              return yield* fail("lease", { _tag: "InUse" });
            const worktree = yield* ensure(card);
            yield* Ref.update(leases, HashSet.add(key));
            return worktree;
          }),
        ),
        () => Ref.update(leases, HashSet.remove(cardKey(card))),
      ),

    /** The card's worktree when it exists on disk. */
    find: (card: CardRef) =>
      Effect.map(lookup("lease", card), (found) =>
        found.state === "present" ? Option.some(found.worktree) : Option.none<CardWorktree>(),
      ),

    /** Applies the retention rule for a card that left execution; see {@link WorktreeDisposition}. */
    settle: Effect.fn("CardWorktrees.settle")(function* (
      card: CardRef,
      disposition: WorktreeDisposition,
    ) {
      switch (disposition._tag) {
        case "Blocked":
        case "HumanDecision":
          yield* checkIds("settle", [card.goalInstanceId, card.cardId]);
          return { _tag: "Retained" } satisfies WorktreeSettlement;
        case "Done":
        case "Cancelled":
          break;
      }
      return yield* serially(
        cardKey(card),
        Effect.gen(function* (): Effect.fn.Return<WorktreeSettlement, CardWorktreeFailed> {
          if (HashSet.has(yield* Ref.get(leases), cardKey(card)))
            return yield* fail("settle", { _tag: "InUse" });
          const found = yield* lookup("settle", card);
          const { worktree } = found;
          const keepBranch = disposition._tag === "Cancelled";
          switch (found.state) {
            case "present":
              if (keepBranch)
                yield* commitIn("settle", worktree, `Cancelled card ${card.cardId} (snapshot)`);
              else if (!(yield* isClean("settle", worktree.path)))
                return yield* fail("settle", { _tag: "WorktreeDirty" });
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
              yield* expect("settle", worktree.repository, ["branch", "-D", worktree.branch]).pipe(
                Effect.uninterruptible,
              );
          }
          return { _tag: "Removed", branchKept: keepBranch };
        }),
      );
    }),

    /** Commits the card's uncommitted work to its branch, for verify and integration to see. */
    commitWork: Effect.fn("CardWorktrees.commitWork")(function* (card: CardRef, message: string) {
      return yield* serially(
        cardKey(card),
        Effect.flatMap(presentWorktree("commit", card), (worktree) =>
          commitIn("commit", worktree, message),
        ),
      );
    }),

    /**
     * Brings Goal branch changes made since the card started into the card branch with a merge
     * commit. Conflicts are aborted and reported by file; the caller decides what happens next.
     * A `Merged` card must be verified again before {@link squashIntoGoal}.
     */
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
              return yield* fail("sync", { _tag: "WorktreeDirty" });
            const head = yield* goalHead("sync", worktree.repository, card.goalInstanceId);
            if (
              yield* answers("sync", worktree.path, ["merge-base", "--is-ancestor", head, "HEAD"])
            )
              return { _tag: "UpToDate" };
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
              return {
                _tag: "Merged",
                head: yield* expect("sync", worktree.path, ["rev-parse", "HEAD"]),
              };
            const files = lines(
              yield* expect("sync", worktree.path, ["diff", "--name-only", "--diff-filter=U"]),
            );
            yield* expect("sync", worktree.path, ["merge", "--abort"]).pipe(Effect.uninterruptible);
            return yield* files.length === 0
              ? fail("sync", { _tag: "GitFailed", exitCode: merged.exitCode })
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
     * Puts the card on the Goal branch as one squash commit whose tree is the card branch's. The
     * card must already contain the Goal HEAD ({@link syncWithGoal}); otherwise `GoalAdvanced`.
     * Integrations of one Goal run one at a time, and the ref moves only from the HEAD that was read.
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
            if (earlier !== undefined) return { _tag: "AlreadyIntegrated", commit: earlier };
            if (!(yield* isClean("squash", worktree.path)))
              return yield* fail("squash", { _tag: "WorktreeDirty" });
            if (
              !(yield* answers("squash", worktree.path, [
                "merge-base",
                "--is-ancestor",
                head,
                "HEAD",
              ]))
            )
              return yield* fail("squash", { _tag: "GoalAdvanced" });
            const tree = yield* expect("squash", worktree.path, ["rev-parse", "HEAD^{tree}"]);
            if (
              tree ===
              (yield* expect("squash", worktree.repository, ["rev-parse", `${head}^{tree}`]))
            )
              return { _tag: "NoChanges" };
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
            return { _tag: "Integrated", commit };
          }),
        ),
      );
    }),

    /** The branch checked out in the project now; none on a detached HEAD. */
    currentBranch: Effect.fn("CardWorktrees.currentBranch")(function* (projectRoot: string) {
      const output = yield* run("goal_branch", projectRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return output.exitCode === 0 ? Option.some(output.stdout.trim()) : Option.none<string>();
    }),

    /** The Goal branch's current commit. */
    goalHead: Effect.fn("CardWorktrees.goalHead")(function* (goal: GoalRef) {
      yield* checkIds("goal_merge", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("goal_merge", goal.projectRoot);
      return yield* goalHead("goal_merge", repository, goal.goalInstanceId);
    }),

    /**
     * Takes the user's branch into the Goal branch with a merge commit written by `merge-tree` and
     * `commit-tree`, so no checkout is touched. Conflicts write nothing and are reported by file.
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
            return yield* fail("goal_merge", { _tag: "TargetMissing" });
          const head = yield* goalHead("goal_merge", repository, goal.goalInstanceId);
          if (
            yield* answers("goal_merge", repository, [
              "merge-base",
              "--is-ancestor",
              targetHead.value,
              head,
            ])
          )
            return { _tag: "UpToDate", head };
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
              return yield* fail("goal_merge", { _tag: "GitFailed", exitCode: merged.exitCode });
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
          return { _tag: "Merged", from: head, head: commit, files };
        }),
      );
    }),

    /**
     * Moves the user's branch forward to `head` of the Goal branch. A branch checked out somewhere
     * moves only through that checkout's own fast-forward, and never while it has uncommitted
     * changes to tracked files; git also refuses to overwrite untracked ones. Elsewhere the ref
     * moves only from the commit that was read.
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
          if (Option.isNone(before)) return yield* fail("goal_merge", { _tag: "TargetMissing" });
          if (before.value === head) return { _tag: "Advanced", commit: head };
          if (
            !(yield* answers("goal_merge", repository, [
              "merge-base",
              "--is-ancestor",
              before.value,
              head,
            ]))
          )
            return { _tag: "TargetMoved" };
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
              ? { _tag: "Advanced", commit: head }
              : { _tag: "TargetMoved" };
          }
          const changes = yield* expect("goal_merge", checkout.path, [
            "status",
            "--porcelain",
            "--untracked-files=no",
          ]);
          if (changes.length > 0) return { _tag: "WorktreeBusy", worktree: checkout.path };
          const moved = yield* run("goal_merge", checkout.path, [
            "merge",
            "--ff-only",
            "--quiet",
            head,
          ]).pipe(Effect.uninterruptible);
          if (moved.exitCode === 0) return { _tag: "Advanced", commit: head };
          const after = yield* read;
          return Option.contains(after, before.value)
            ? { _tag: "WorktreeBusy", worktree: checkout.path }
            : { _tag: "TargetMoved" };
        }),
      );
    }),

    /**
     * A detached checkout of the Goal branch at `head` for the Goal-level check, removed when the
     * scope closes. A checkout a crash left behind is removed first.
     */
    goalCheckout: (
      goal: GoalRef,
      head: string,
    ): Effect.Effect<CardWorktree, CardWorktreeFailed, Scope.Scope> =>
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
                  reason: { _tag: "GitFailed", exitCode: null },
                  cause,
                }),
              ),
            );
            yield* fs.makeDirectory(path.dirname(folder), { recursive: true, mode: 0o700 }).pipe(
              Effect.mapError((cause) =>
                CardWorktreeFailed.make({
                  operation: "checkout",
                  reason: { _tag: "GitFailed", exitCode: null },
                  cause,
                }),
              ),
            );
            yield* expect("checkout", repository, ["worktree", "add", "--detach", folder, head]);
            return {
              goalInstanceId: goal.goalInstanceId,
              cardId: goalCheckoutFolder,
              repository,
              branch: goalBranchName(goal.goalInstanceId),
              path: folder,
              toolRoot: prefix.length === 0 ? folder : path.join(folder, prefix),
              worktreesBase: base,
            } satisfies CardWorktree;
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
      ),

    /**
     * Pushes the Goal branch to `origin` under its own name, for a pull request a person asked for.
     * The exit code is returned as observed; a push is never repeated here.
     */
    pushGoalBranch: Effect.fn("CardWorktrees.pushGoalBranch")(function* (goal: GoalRef) {
      yield* checkIds("push", [goal.goalInstanceId]);
      const { repository } = yield* repositoryOf("push", goal.projectRoot);
      const branch = `refs/heads/${goalBranchName(goal.goalInstanceId)}`;
      const pushed = yield* run("push", repository, ["push", "origin", `${branch}:${branch}`]).pipe(
        Effect.uninterruptible,
      );
      return pushed.exitCode === 0;
    }),
  };
});

export { goalBranchName };

/** Card worktrees and Goal branches of kanban execution. Owner process only. */
export class CardWorktrees extends Context.Service<
  CardWorktrees,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/kanban/worktree/CardWorktrees") {
  static readonly layer = (worktreesBase?: string) =>
    Layer.effect(
      CardWorktrees,
      Effect.flatMap(
        worktreesBase === undefined ? defaultWorktreesBase : Effect.succeed(worktreesBase),
        make,
      ),
    );
}
