import { Context, Data, Effect, Layer, Option } from "effect";
import { Number as EffectNumber } from "effect";
import { Workflows } from "../workflow/workflow.ts";
import { CardAttempts, type KanbanGoal } from "./card-attempts.ts";
import {
  CardWorktrees,
  WorktreeDisposition,
  type CardRef,
  type CardWorktreeFailed,
} from "./worktree.ts";

/**
 * Clean-up of card worktrees once their Goal ends (docs/kanban-orchestration.md "worktree 정리").
 * A Goal folder below the worktrees base is this owner's when its Goal instance is in this
 * database: instance ids are random UUIDs, so another install's folders and a deleted
 * conversation's are never touched. Card worktrees go through {@link CardWorktrees.settle}, so work
 * nobody committed stays on the card branch, and no branch is deleted here.
 */

/** What the startup sweep does with what it finds; `report` only logs, until the logs show its judgement holds. */
export type SweepMode = "report" | "delete";
const sweepMode: SweepMode = "report";

/** The startup sweep's counts, also on its span. */
export interface SweepSummary {
  /** Goal folders and card folders looked at. */
  readonly found: number;
  /** Folders and registered worktrees nothing uses again. */
  readonly orphaned: number;
  /** Of those, the ones `delete` removed. */
  readonly cleaned: number;
  /** Folders of other installs or deleted conversations, and folders still in use. */
  readonly skipped: number;
}

/** Something below the worktrees base nothing uses again. */
type Orphan = Data.TaggedEnum<{
  Card: { readonly card: CardRef; readonly disposition: WorktreeDisposition };
  /** An ended Goal's own folder with its Goal-level checkout, once its cards are settled. */
  Goal: { readonly goal: KanbanGoal };
}>;
const Orphan = Data.taggedEnum<Orphan>();

/** The sweep's judgement of one Goal folder. */
interface Judgement {
  readonly found: number;
  readonly skipped: number;
  readonly orphans: readonly Orphan[];
  /** The Goal's project when it is in this database, whose repository is checked for gone folders. */
  readonly projectRoot: string | null;
}

const make = Effect.gen(function* () {
  const worktrees = yield* CardWorktrees;
  const attempts = yield* CardAttempts;
  const workflows = yield* Workflows;

  const cardOf = (goal: KanbanGoal, cardId: string): CardRef => ({
    projectRoot: goal.projectRoot,
    goalInstanceId: goal.goalInstanceId,
    cardId,
  });
  const warned =
    (message: string, at: Readonly<Record<string, string>>) => (failure: CardWorktreeFailed) =>
      Effect.as(Effect.logWarning(message, { ...at, reason: failure.reason._tag }), false);

  /**
   * Whether a stopped Goal ended by its Plan closing or by a new Goal taking over the conversation.
   * Deleting the conversation stops its Goals too, and keeps what is on disk.
   */
  const ended = Effect.fnUntraced(function* (goal: KanbanGoal) {
    if (goal.active || goal.mode === "sequential") return false;
    if ((yield* workflows.goalInstanceId(goal.sessionId)) !== goal.goalInstanceId) return true;
    return (yield* workflows.get(goal.sessionId)).plan?.status === "closed";
  });

  /** Settles one card's worktree; false when it stays. */
  const settleCard = (card: CardRef, disposition: WorktreeDisposition) =>
    worktrees.settle(card, disposition).pipe(
      Effect.as(true),
      Effect.catchReason(
        "CardWorktreeFailed",
        "InUse",
        // The attempt holding it settles it when its delivery ends.
        () => Effect.succeed(false),
        (_, failure) =>
          warned("Card worktree was not settled", {
            goalInstanceId: card.goalInstanceId,
            cardId: card.cardId,
          })(failure),
      ),
    );
  const removeGoalFolder = (goal: KanbanGoal) =>
    worktrees
      .removeGoalFolder(goal)
      .pipe(
        Effect.catchTag(
          "CardWorktreeFailed",
          warned("Goal folder was not removed", { goalInstanceId: goal.goalInstanceId }),
        ),
      );

  /**
   * Settles what a Goal that ended leaves: each card's worktree as cancelled, its work kept on the
   * card branch, then the Goal's folder once it is empty. A card an attempt still holds is settled
   * when its delivery ends.
   */
  const settleGoal = Effect.fn("CardWorkspaceJanitor.settleGoal")(
    function* (goal: KanbanGoal) {
      if (goal.mode === "sequential") return;
      const folder = yield* worktrees.goalFolder(goal.goalInstanceId);
      const settled = yield* Effect.forEach(folder.cardIds, (cardId) =>
        settleCard(cardOf(goal, cardId), WorktreeDisposition.Cancelled()),
      );
      const removed = yield* removeGoalFolder(goal);
      yield* Effect.annotateCurrentSpan({
        cards: folder.cardIds.length,
        settled: settled.filter(Boolean).length,
        removed: removed ? 1 : 0,
      });
    },
    Effect.catchTag("CardWorktreeFailed", (failure) =>
      Effect.logWarning("Goal folder was not read", { reason: failure.reason._tag }),
    ),
  );

  /** After a delivery's lease closed: a Goal that ended meanwhile left the card's worktree to it. */
  const settleDelivered = Effect.fn("CardWorkspaceJanitor.settleDelivered")(
    function* (goalInstanceId: string, cardId: string) {
      const goal = yield* attempts.goal(goalInstanceId);
      if (Option.isNone(goal) || !(yield* ended(goal.value))) return;
      yield* Effect.when(
        removeGoalFolder(goal.value),
        settleCard(cardOf(goal.value, cardId), WorktreeDisposition.Cancelled()),
      );
    },
    Effect.catchTags({
      KanbanStorageFailed: () => Effect.logWarning("Delivered card's Goal was not read"),
      WorkflowStorageError: () => Effect.logWarning("Delivered card's Goal was not read"),
    }),
  );

  /**
   * One Goal folder judged against this database and the board. A stopped Goal that ended leaves
   * everything in it; a running board leaves the folders of cards that are done or no longer on its
   * Plan, while an attempt is pending or the Plan still has the card unfinished it is in use.
   */
  const judge = Effect.fnUntraced(function* (goalInstanceId: string) {
    const folder = yield* worktrees.goalFolder(goalInstanceId);
    const found = 1 + folder.cardIds.length;
    const stored = yield* attempts.goal(goalInstanceId);
    if (Option.isNone(stored) || stored.value.mode === "sequential")
      return { found, skipped: found, orphans: [], projectRoot: null } satisfies Judgement;
    const goal = stored.value;
    const kept: Judgement = { found, skipped: found, orphans: [], projectRoot: goal.projectRoot };
    if (!goal.active)
      return (yield* ended(goal))
        ? {
            ...kept,
            skipped: 0,
            orphans: [
              ...folder.cardIds.map((cardId) =>
                Orphan.Card({
                  card: cardOf(goal, cardId),
                  disposition: WorktreeDisposition.Cancelled(),
                }),
              ),
              Orphan.Goal({ goal }),
            ],
          }
        : kept;
    // A new Goal took over: the board's next look settles its folder.
    if ((yield* workflows.goalInstanceId(goal.sessionId)) !== goalInstanceId) return kept;
    const pending = new Set(
      (yield* attempts.pending(goalInstanceId)).map((attempt) => attempt.cardId),
    );
    const steps = (yield* workflows.get(goal.sessionId)).plan?.steps ?? [];
    const orphans = folder.cardIds.flatMap((cardId) => {
      const step = steps.find((candidate) => candidate.id === cardId);
      if (pending.has(cardId) || (step !== undefined && step.status !== "done")) return [];
      return [
        Orphan.Card({
          card: cardOf(goal, cardId),
          disposition:
            step === undefined ? WorktreeDisposition.Cancelled() : WorktreeDisposition.Done(),
        }),
      ];
    });
    return { ...kept, skipped: found - orphans.length, orphans };
  });

  const clean = Orphan.$match({
    Card: ({ card, disposition }) => settleCard(card, disposition),
    Goal: ({ goal }) => removeGoalFolder(goal),
  });

  /**
   * Looks at everything below the worktrees base: `report` logs what nothing uses again, `delete`
   * also settles it. Registered worktrees whose folders are gone are forgotten by `git worktree
   * prune`. Each finding is a warning with its Goal, card and judgement.
   */
  const sweep = Effect.fn("CardWorkspaceJanitor.sweep")(function* (mode: SweepMode) {
    const judgements = yield* Effect.forEach(yield* worktrees.goalFolders, judge);
    const roots = new Set([
      ...judgements.flatMap((judgement) =>
        judgement.projectRoot === null ? [] : [judgement.projectRoot],
      ),
      ...(yield* attempts.activeGoals)
        .filter((goal) => goal.mode === "worktree")
        .map((goal) => goal.projectRoot),
    ]);
    // Several projects can share a repository; each gone folder counts once.
    const stale = new Map(
      (yield* Effect.forEach(roots, (root) =>
        Effect.map(worktrees.staleWorktrees(root), (paths) =>
          paths.map((path) => [path, root] as const),
        ),
      )).flat(),
    );
    const orphans = judgements.flatMap((judgement) => judgement.orphans);
    yield* Effect.forEach(
      orphans,
      Orphan.$match({
        Card: ({ card, disposition }) =>
          Effect.logWarning("Card worktree left behind", {
            goalInstanceId: card.goalInstanceId,
            cardId: card.cardId,
            disposition: disposition._tag,
            mode,
          }),
        Goal: ({ goal }) =>
          Effect.logWarning("Goal folder left behind", {
            goalInstanceId: goal.goalInstanceId,
            mode,
          }),
      }),
      { discard: true },
    );
    yield* Effect.forEach(
      stale.keys(),
      (path) => Effect.logWarning("Registered worktree without its folder", { path, mode }),
      { discard: true },
    );
    const cleaned =
      mode === "report"
        ? 0
        : (yield* Effect.forEach(orphans, clean)).filter(Boolean).length +
          EffectNumber.sumAll(
            yield* Effect.forEach(new Set(stale.values()), (root) =>
              worktrees.prune(root).pipe(
                Effect.as([...stale.values()].filter((other) => other === root).length),
                Effect.catchTag("CardWorktreeFailed", (failure) =>
                  Effect.as(warned("Registered worktrees were not pruned", { root })(failure), 0),
                ),
              ),
            ),
          );
    const summary: SweepSummary = {
      found: EffectNumber.sumAll(judgements.map((judgement) => judgement.found)),
      orphaned: orphans.length + stale.size,
      cleaned,
      skipped: EffectNumber.sumAll(judgements.map((judgement) => judgement.skipped)),
    };
    yield* Effect.annotateCurrentSpan({ ...summary });
    return summary;
  });

  return { settleGoal, settleDelivered, sweep };
});

/** Clean-up of card worktrees left by Goals that ended. Owner process only. */
export class CardWorkspaceJanitor extends Context.Service<
  CardWorkspaceJanitor,
  Effect.Success<typeof make>
>()("memory-agent/kanban/workspace-janitor/CardWorkspaceJanitor") {
  /** Sweeps once as it is built: before any card runs and before any board recovers. */
  static readonly layer = Layer.effect(
    CardWorkspaceJanitor,
    Effect.tap(make, (janitor) =>
      janitor.sweep(sweepMode).pipe(
        // A failed sweep leaves the folders as they are; the owner still starts.
        Effect.catchCause((cause) => Effect.logWarning("Card worktree sweep failed", cause)),
      ),
    ),
  );
}
