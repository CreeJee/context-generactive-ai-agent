import { Context, Data, Effect, Schema } from "effect";
import { Function as EffectFunction } from "effect";
import type { Option, Scope } from "effect";
import type { Fenced } from "../files/paths.ts";
import type { KanbanMode } from "./card-attempts.ts";

/**
 * The contract of kanban card worktrees (docs/kanban-orchestration.md "실행", "브랜치 흐름"). A Goal
 * gets its own line of history from the user's current HEAD; each card works in a worktree of its
 * own, finished cards join the Goal one at a time, and the Goal then merges into the user's branch.
 * The card queue, the orchestrator and the merge queue depend on this contract only; the git
 * implementation is `git-worktrees.ts`.
 */

export interface GoalRef {
  /** The project folder the Goal runs for; it may be below the repository top. */
  readonly projectRoot: string;
  readonly goalInstanceId: string;
}

export interface CardRef extends GoalRef {
  readonly cardId: string;
}

/** A worktree as the card's file and shell tools see it. */
export interface CardWorktree {
  /** Where the project sits inside the worktree; the card's file and shell tools start here. */
  readonly toolRoot: string;
  /** Folders the card's tools must not reach, such as the user's checkout and other worktrees. */
  readonly deniedRoots: readonly string[];
}

/**
 * What happens to a card worktree once the card leaves execution. `Done` work is in the Goal
 * branch, so the worktree and card branch go. `Cancelled` work is committed to the card branch as a
 * snapshot before the worktree goes, so it stays recoverable. `Blocked` and `HumanDecision` keep
 * the worktree for the next attempt or for the person deciding.
 */
export type WorktreeDisposition = Data.TaggedEnum<{
  Done: {};
  Cancelled: {};
  Blocked: {};
  HumanDecision: {};
}>;
export const WorktreeDisposition = Data.taggedEnum<WorktreeDisposition>();

export type WorktreeSettlement = Data.TaggedEnum<{
  Removed: { readonly branchKept: boolean };
  Retained: {};
}>;
export const WorktreeSettlement = Data.taggedEnum<WorktreeSettlement>();

export type GoalSync = Data.TaggedEnum<{
  UpToDate: {};
  Merged: { readonly head: string };
}>;
export const GoalSync = Data.taggedEnum<GoalSync>();

export type CardIntegration = Data.TaggedEnum<{
  Integrated: { readonly commit: string };
  AlreadyIntegrated: { readonly commit: string };
  NoChanges: {};
}>;
export const CardIntegration = Data.taggedEnum<CardIntegration>();

/** The user's branch taken into the Goal branch. */
export type TargetSync = Data.TaggedEnum<{
  UpToDate: { readonly head: string };
  /** `files` changed between the Goal branch at `from` and the merge commit `head`. */
  Merged: {
    readonly from: string;
    readonly head: string;
    readonly files: readonly string[];
  };
}>;
export const TargetSync = Data.taggedEnum<TargetSync>();

/** Moving the user's branch to the Goal branch head. */
export type TargetAdvance = Data.TaggedEnum<{
  Advanced: { readonly commit: string };
  /** The branch moved past what the Goal branch contains; take it in and check again. */
  TargetMoved: {};
  /** The branch is checked out with uncommitted changes, or the checkout refused to move. */
  WorktreeBusy: { readonly worktree: string };
}>;
export const TargetAdvance = Data.taggedEnum<TargetAdvance>();

/**
 * The project as a card's tools see it: rooted at the card worktree, with what the worktree denies
 * fenced off from the outside tools. Credential and storage-root refusals are unchanged; this only
 * narrows.
 */
export const cardToolProject: {
  (worktree: CardWorktree): <P extends { readonly root: string }>(project: P) => Fenced<P>;
  <P extends { readonly root: string }>(project: P, worktree: CardWorktree): Fenced<P>;
} = EffectFunction.dual(
  2,
  <P extends { readonly root: string }>(project: P, worktree: CardWorktree): Fenced<P> => ({
    ...project,
    root: worktree.toolRoot,
    toolFence: { deniedRoots: worktree.deniedRoots },
  }),
);

const SequentialCause = Schema.Literals(["git_unavailable", "not_git_repository", "no_commits"]);

export const CardWorktreeFailedReason = Schema.TaggedUnion({
  /** No worktree can exist here: run the Goal's cards one after another instead. */
  SequentialRequired: { cause: SequentialCause },
  InvalidId: {},
  /** The worktree base would sit inside the project or the storage root. */
  UnsafeWorktreeBase: {},
  GoalBranchMissing: {},
  /** Something other than this card's worktree occupies its folder. */
  WorktreeOccupied: {},
  WorktreeMissing: {},
  WorktreeDirty: {},
  /** An attempt still holds the worktree. */
  InUse: {},
  /** The Goal branch moved past the card branch; sync the card first and verify again. */
  GoalAdvanced: {},
  /** The branch the Goal merges into no longer exists. */
  TargetMissing: {},
  GitFailed: { exitCode: Schema.NullOr(Schema.Finite) },
});
export type CardWorktreeFailedReason = typeof CardWorktreeFailedReason.Type;

/** The reason's tag, as failure codes and the board name it. */
export const cardWorktreeFailedReasonName = CardWorktreeFailedReason.match({
  SequentialRequired: () => "SequentialRequired" as const,
  InvalidId: () => "InvalidId" as const,
  UnsafeWorktreeBase: () => "UnsafeWorktreeBase" as const,
  GoalBranchMissing: () => "GoalBranchMissing" as const,
  WorktreeOccupied: () => "WorktreeOccupied" as const,
  WorktreeMissing: () => "WorktreeMissing" as const,
  WorktreeDirty: () => "WorktreeDirty" as const,
  InUse: () => "InUse" as const,
  GoalAdvanced: () => "GoalAdvanced" as const,
  TargetMissing: () => "TargetMissing" as const,
  GitFailed: () => "GitFailed" as const,
});

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
    reason: CardWorktreeFailedReason,
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

/** What a card's run, verification and integration do with its worktree. */
export interface CardWorkspace {
  /**
   * The card's worktree for one attempt: made from the Goal branch HEAD, or the existing one when
   * the card continues. While the scope is open nothing settles the worktree away.
   */
  readonly lease: (card: CardRef) => Effect.Effect<CardWorktree, CardWorktreeFailed, Scope.Scope>;
  /** The card's worktree when it exists. */
  readonly find: (card: CardRef) => Effect.Effect<Option.Option<CardWorktree>, CardWorktreeFailed>;
  /** Applies the retention rule for a card that left execution; see {@link WorktreeDisposition}. */
  readonly settle: (
    card: CardRef,
    disposition: WorktreeDisposition,
  ) => Effect.Effect<WorktreeSettlement, CardWorktreeFailed>;
  /** Commits the card's uncommitted work, for verify and integration to see; none when there was nothing. */
  readonly commitWork: (
    card: CardRef,
    message: string,
  ) => Effect.Effect<Option.Option<string>, CardWorktreeFailed>;
  /**
   * Brings Goal branch changes made since the card started into the card. Conflicts are reported
   * by file and nothing is resolved automatically; the caller decides what happens next. A
   * `Merged` card must be verified again before {@link CardWorkspace.squashIntoGoal}.
   */
  readonly syncWithGoal: (
    card: CardRef,
  ) => Effect.Effect<GoalSync, CardWorktreeFailed | CardIntegrationConflict>;
  /**
   * Puts the card on the Goal branch as one commit. The card must already contain the Goal HEAD
   * ({@link CardWorkspace.syncWithGoal}); otherwise `GoalAdvanced`. Integrations of one Goal run one
   * at a time.
   */
  readonly squashIntoGoal: (
    card: CardRef,
    title: string,
  ) => Effect.Effect<CardIntegration, CardWorktreeFailed>;
  /** Where a card's work stays once it leaves the board, told to the card that re-applies it. */
  readonly earlierWork: (card: CardRef) => string;
}

/** Card worktrees together with the Goal branch they join and its way into the user's branch. */
export interface CardWorktreesApi extends CardWorkspace {
  /**
   * Starts the Goal branch at the user's current HEAD unless it exists; the user's checkout, index
   * and current branch stay as they are. `SequentialRequired` where no worktree can exist.
   */
  readonly prepareGoal: (goal: GoalRef) => Effect.Effect<void, CardWorktreeFailed>;
  /** The branch checked out in the project now; none on a detached HEAD. */
  readonly currentBranch: (
    projectRoot: string,
  ) => Effect.Effect<Option.Option<string>, CardWorktreeFailed>;
  /** The Goal branch's current commit. */
  readonly goalHead: (goal: GoalRef) => Effect.Effect<string, CardWorktreeFailed>;
  /**
   * Takes the user's branch into the Goal branch without touching any checkout. Conflicts write
   * nothing and are reported by file.
   */
  readonly mergeTargetIntoGoal: (
    goal: GoalRef,
    target: string,
  ) => Effect.Effect<TargetSync, CardWorktreeFailed | GoalMergeConflict>;
  /**
   * Moves the user's branch forward to `head` of the Goal branch. A checkout with uncommitted
   * changes is waited for, never overwritten.
   */
  readonly advanceTarget: (
    goal: GoalRef,
    target: string,
    head: string,
  ) => Effect.Effect<TargetAdvance, CardWorktreeFailed>;
  /** A checkout of the Goal branch at `head` for the Goal-level check, removed when the scope closes. */
  readonly goalCheckout: (
    goal: GoalRef,
    head: string,
  ) => Effect.Effect<CardWorktree, CardWorktreeFailed, Scope.Scope>;
  /**
   * Pushes the Goal branch to `origin`, for a pull request a person asked for: the pushed branch,
   * or none when the push failed. A push is never repeated.
   */
  readonly pushGoalBranch: (
    goal: GoalRef,
  ) => Effect.Effect<Option.Option<string>, CardWorktreeFailed>;
}

/** Card worktrees and Goal branches of kanban execution. Owner process only. */
export class CardWorktrees extends Context.Service<CardWorktrees, CardWorktreesApi>()(
  "memory-agent/kanban/worktree/CardWorktrees",
) {}

const projectItself = (card: CardRef): CardWorktree => ({
  toolRoot: card.projectRoot,
  deniedRoots: [],
});

/**
 * The cards of a project that cannot have worktrees: each runs in the project itself, one at a
 * time, so its work is already where it belongs and there is nothing to keep, commit or merge.
 */
export const sequentialWorkspace: CardWorkspace = {
  lease: (card) => Effect.succeed(projectItself(card)),
  find: (card) => Effect.succeedSome(projectItself(card)),
  settle: () => Effect.succeed(WorktreeSettlement.Retained()),
  commitWork: () => Effect.succeedNone,
  syncWithGoal: () => Effect.succeed(GoalSync.UpToDate()),
  squashIntoGoal: () => Effect.succeed(CardIntegration.NoChanges()),
  earlierWork: () => "Its changes are in the project as it is now.",
};

/** Where a Goal's cards run, by the mode its board started in. */
export const cardWorkspace: {
  (mode: KanbanMode): (worktrees: CardWorkspace) => CardWorkspace;
  (worktrees: CardWorkspace, mode: KanbanMode): CardWorkspace;
} = EffectFunction.dual(
  2,
  (worktrees: CardWorkspace, mode: KanbanMode): CardWorkspace =>
    ({ worktree: worktrees, sequential: sequentialWorkspace })[mode],
);
