import { Context, Effect, Layer, Match, Option, Predicate, Schema, type Types } from "effect";
import {
  BoardEdit,
  BoardEditRefused,
  BoardEditResult,
  CardDraft,
  CardPatch,
  UserChange,
  type BoardIntent,
} from "../workflow/board-edit.ts";
import { CardStatus, type BoardAuthor } from "../workflow/card.ts";
import { Workflows, type PlanStep } from "../workflow/workflow.ts";
import { boardOps } from "./board-ops.ts";
import {
  CardAttempts,
  type AssignmentHold,
  type KanbanGoal,
  type KanbanMode,
} from "./card-attempts.ts";
import { cardQueueName } from "./card-queue.ts";
import { CardHoldReason } from "./failures.ts";
import {
  DecisionCloseScope,
  DecisionKind,
  HumanDecisions,
  type DecisionCloseReason,
} from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";
import { CardWorktrees, WorktreeDisposition } from "./worktree.ts";
import { Sessions } from "../sessions/sessions.ts";
import { GoalSchedules, type GoalMergeState } from "./goal-schedules.ts";
import { ProjectScheduler } from "./scheduler.ts";
import { BoardHealth } from "./board-health.ts";
import type { LoopHealth } from "../runtime/loop-health.ts";

/**
 * What the orchestrator model does on a kanban board (docs/kanban-orchestration.md "수정 권한",
 * "식별자와 Goal 변경"): split, merge, cancel and move cards, settle users' change requests to
 * executing cards, and apply its classification of cards against a changed Goal. Every change is
 * saved with the `Orchestrator` author of the calling run. The deterministic loop picks the board
 * up from there.
 */

export class KanbanActionRefused extends Schema.TaggedError<KanbanActionRefused>()(
  "KanbanActionRefused",
  {
    reason: Schema.Literals([
      "not_kanban",
      "card_missing",
      "card_running",
      "request_missing",
      "request_settled",
      "reassign_needs_edit",
      "no_goal_change",
      "card_not_blocked",
      "card_not_running",
      "reorder_across_columns",
      /** A card waiting for a person's decision stays until it is answered or cancelled. */
      "card_waiting",
      /** Other cards of the Plan depend on it; they would be left waiting for nothing. */
      "card_has_dependents",
      /** The transfer target is this Plan, another project's conversation, or has no Plan. */
      "transfer_target_invalid",
    ]),
  },
) {}

/** How the orchestrator settles a user's change to an executing card. */
export const ChangeDecision = Schema.TaggedUnion({
  /** Apply it now; a running attempt stops and the card continues with the change at once. */
  Apply: {},
  /** Stop the attempt, apply the change, and reschedule the card in a fresh agent conversation. */
  Reassign: {},
  Reject: { reason: Schema.NonEmptyString },
});
export type ChangeDecision = typeof ChangeDecision.Type;

/** The orchestrator's judgement of one card against a changed Goal. */
export const GoalChangeVerdict = Schema.TaggedUnion({
  Continue: { cardId: Schema.String },
  Amend: {
    cardId: Schema.String,
    patch: CardPatch,
    note: Schema.NonEmptyString,
  },
  Stop: { cardId: Schema.String, reason: Schema.NonEmptyString },
  Replace: { cardId: Schema.String, card: CardDraft },
  NeedsDecision: { cardId: Schema.String, question: Schema.NonEmptyString },
});
export type GoalChangeVerdict = typeof GoalChangeVerdict.Type;

/** What the loop knows about a card beyond the Plan. */
export interface KanbanCardView {
  readonly cardId: string;
  readonly status: CardStatus;
  /** Why the loop stopped or delayed the card. */
  readonly reason: CardHoldReason | null;
  readonly failures: number;
  readonly replans: number;
  /** The card a resolution card re-applies. */
  readonly resolutionOf: string | null;
  readonly requeueable: boolean;
}

/** Another kanban Goal of the project, as a Goal this one can wait for. */
export interface KanbanGoalOption {
  readonly goalInstanceId: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly statement: string | null;
  readonly merge: GoalMergeState | null;
}

/**
 * How the project scheduler treats the board's Goal. Its place in the priority tree is the
 * project board's business (`GoalOrder`), not the Goal's own.
 */
export interface KanbanScheduleView {
  /** The branch the Goal merges into; none when the board started on a detached HEAD. */
  readonly targetBranch: string | null;
  readonly dependsOn: readonly string[];
  /** The Goals it depends on that have not merged yet; while any remain it takes no slots. */
  readonly waitingOn: readonly string[];
  readonly merge: GoalMergeState | null;
  readonly upstreamPending: boolean;
  readonly otherGoals: readonly KanbanGoalOption[];
}

export interface KanbanBoardView {
  readonly goalInstanceId: string;
  readonly mode: KanbanMode;
  readonly goalChange: AssignmentHold | null;
  readonly cards: readonly KanbanCardView[];
  readonly schedule: KanbanScheduleView | null;
  /** How the board's loop stands; a stopped one waits for `restartLoop`. */
  readonly loop: LoopHealth;
}

/** A card attempt is running or waiting in the queue while the card is in these columns. */
const running = (card: PlanStep) => card.status === "in_progress" || card.status === "verify";

/** The card as a draft for another Plan: its contract travels, its dependencies do not. */
const draftOf = (card: PlanStep): CardDraft => {
  const draft: Types.Mutable<CardDraft> = {
    title: card.title,
    description: card.description,
    dependsOn: [],
    acceptanceCriteria: card.acceptanceCriteria,
  };
  if (card.outcome !== undefined) draft.outcome = card.outcome;
  if (card.boundaries !== undefined) draft.boundaries = card.boundaries;
  if (card.risk !== undefined) draft.risk = card.risk;
  if (card.requiredEvidence !== undefined) draft.requiredEvidence = card.requiredEvidence;
  if (card.humanDecision !== undefined) draft.humanDecision = card.humanDecision;
  return draft;
};

const describePatch = (patch: CardPatch) =>
  Object.entries(patch)
    .map(([field, value]) => `${field}: ${JSON.stringify(value)}`)
    .join("; ");

const make = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const ops = boardOps(workflows);
  const attempts = yield* CardAttempts;
  const orchestrator = yield* KanbanOrchestrator;
  const worktrees = yield* CardWorktrees;
  const decisions = yield* HumanDecisions;
  const schedules = yield* GoalSchedules;
  const scheduler = yield* ProjectScheduler;
  const sessions = yield* Sessions;
  const health = yield* BoardHealth;

  const refuse = (reason: KanbanActionRefused["reason"]) => KanbanActionRefused.make({ reason });

  /** The Goal's schedule with the project's other kanban Goals it may wait for. */
  const scheduleView = Effect.fnUntraced(function* (goal: KanbanGoal) {
    const found = yield* schedules.get(goal.goalInstanceId);
    if (Option.isNone(found)) return null;
    const schedule = found.value;
    const edges = yield* schedules.edges(schedule.projectId);
    const others = yield* Effect.forEach(
      (yield* schedules.forProject(schedule.projectId)).filter(
        (other) => other.goalInstanceId !== goal.goalInstanceId,
      ),
      Effect.fnUntraced(function* (other) {
        const kanban = yield* attempts.goal(other.goalInstanceId);
        if (Option.isNone(kanban)) return [];
        const sessionId = kanban.value.sessionId;
        // A Goal its conversation replaced is not one to wait for.
        if ((yield* workflows.goalInstanceId(sessionId)) !== other.goalInstanceId) return [];
        const session = yield* sessions.get(sessionId).pipe(
          Effect.asSome,
          Effect.catchTag("SessionNotFound", () => Effect.succeedNone),
        );
        return [
          {
            goalInstanceId: other.goalInstanceId,
            sessionId,
            sessionTitle: Option.getOrNull(Option.map(session, (s) => s.title ?? null)),
            statement: (yield* workflows.get(sessionId)).goal?.statement ?? null,
            merge: other.merge,
          } satisfies KanbanGoalOption,
        ];
      }),
    );
    return {
      targetBranch: schedule.targetBranch,
      dependsOn: edges.get(goal.goalInstanceId) ?? [],
      waitingOn: yield* scheduler.waitingOn(goal.goalInstanceId),
      merge: schedule.merge,
      upstreamPending: schedule.upstreamPending,
      otherGoals: others.flat(),
    } satisfies KanbanScheduleView;
  });

  /** The board the session's current Goal instance runs, with the card the call is about. */
  const board = Effect.fnUntraced(function* (sessionId: string) {
    const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
    const goal = goalInstanceId === null ? Option.none() : yield* attempts.goal(goalInstanceId);
    return yield* Effect.fromOption(Option.filter(goal, (found) => found.active)).pipe(
      Effect.mapError(() => refuse("not_kanban")),
    );
  });
  /** The board when the session's Goal runs as one; storage failures still fail. */
  const kanbanOf = (sessionId: string) =>
    board(sessionId).pipe(
      Effect.asSome,
      // `board` refuses only with `not_kanban`.
      Effect.catchTag("KanbanActionRefused", () => Effect.succeedNone),
    );
  const cardOf = Effect.fnUntraced(function* (sessionId: string, cardId: string) {
    const step = (yield* workflows.get(sessionId)).plan?.steps.find((card) => card.id === cardId);
    return yield* Effect.fromOption(Option.fromUndefinedOr(step)).pipe(
      Effect.mapError(() => refuse("card_missing")),
    );
  });
  const idle = Effect.fnUntraced(function* (sessionId: string, cardId: string) {
    const card = yield* cardOf(sessionId, cardId);
    return yield* running(card) ? Effect.fail(refuse("card_running")) : Effect.succeed(card);
  });
  /** Ends the cards' open waits for a person; closing is not an answer, so nothing moves. */
  const closeDecisions = (
    goal: KanbanGoal,
    cardIds: readonly string[],
    reason: DecisionCloseReason,
  ) =>
    Effect.forEach(
      cardIds,
      (cardId) =>
        decisions.close(
          DecisionCloseScope.Card({
            sessionId: goal.sessionId,
            goalInstanceId: goal.goalInstanceId,
            cardId,
          }),
          reason,
        ),
      { discard: true },
    );
  /** Takes a card that is not running off the board, keeping its earlier work on its branch. */
  const retire = Effect.fnUntraced(function* (goal: KanbanGoal, cardIds: readonly string[]) {
    yield* closeDecisions(goal, cardIds, "card_stopped");
    yield* Effect.forEach(
      cardIds,
      (cardId) =>
        goal.mode === "worktree"
          ? worktrees.settle(
              { projectRoot: goal.projectRoot, goalInstanceId: goal.goalInstanceId, cardId },
              WorktreeDisposition.Cancelled(),
            )
          : Effect.void,
      { discard: true },
    );
  });
  /**
   * Stops a running card's attempt and puts it where the loop continues it. The attempt's
   * delivery completes as Stopped; the card is assigned again once it has.
   */
  const interrupt = Effect.fnUntraced(function* (
    goal: KanbanGoal,
    card: PlanStep,
    to: CardStatus,
    detail: string,
    author: BoardAuthor,
  ) {
    yield* workflows.transitionCard(
      goal.sessionId,
      { cardId: card.id, from: card.status, to, detail },
      author,
    );
    yield* orchestrator.stopAttempt(goal.goalInstanceId, card.id);
  });
  const note = (goal: KanbanGoal, cardId: string, text: string, generation = 0) =>
    attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
      ...current,
      generation: current.generation + generation,
      notes: [...current.notes, text],
    }));

  /** Applies a card change; a running card stops and continues with it. */
  const amend = Effect.fnUntraced(function* (
    goal: KanbanGoal,
    card: PlanStep,
    patch: CardPatch,
    text: string,
    author: BoardAuthor,
    fresh: boolean,
  ) {
    yield* ops.editCard(goal.sessionId, card.id, patch, author);
    yield* note(goal, card.id, text, fresh ? 1 : 0);
    if (running(card))
      yield* interrupt(
        goal,
        card,
        card.status === "verify" ? "in_progress" : "ready",
        `card ${card.id} changed: ${text}`,
        author,
      );
  });

  /**
   * Moves a card. Moving a running card stops its attempt. A blocked or waiting card moved back
   * to ready starts a new failure streak, and counts as replanned when it was waiting for that.
   */
  const moveCard = Effect.fn("KanbanBoardActions.moveCard")(function* (
    sessionId: string,
    move: { readonly cardId: string; readonly from: CardStatus; readonly to: CardStatus },
    author: BoardAuthor,
  ) {
    const goal = yield* board(sessionId);
    const card = yield* cardOf(sessionId, move.cardId);
    const detail = `card ${move.cardId} ${move.from} -> ${move.to}`;
    // Moving a waiting card decides for the person; their wait ends unanswered.
    if (card.status === "human_decision" && move.to !== "human_decision")
      yield* closeDecisions(goal, [card.id], "orchestrator_cancelled");
    if (running(card) && card.status === move.from)
      yield* interrupt(goal, card, move.to, detail, author);
    else yield* workflows.transitionCard(sessionId, { ...move, detail }, author);
    if (move.to === "ready" || move.to === "backlog")
      yield* attempts.updateLadder(goal.goalInstanceId, move.cardId, (current) => ({
        ...current,
        failureStreak: 0,
        notBefore: null,
        replans: current.replans + (Predicate.isTagged(current.reason, "ReplanRequested") ? 1 : 0),
        reason: null,
      }));
    yield* orchestrator.poke(goal.goalInstanceId);
  });

  return {
    /** Replaces a card that is not running with smaller cards; its dependents wait for all of them. */
    splitCard: Effect.fn("KanbanBoardActions.splitCard")(function* (
      sessionId: string,
      cardId: string,
      parts: readonly CardDraft[],
      author: BoardAuthor,
    ) {
      const goal = yield* board(sessionId);
      const card = yield* idle(sessionId, cardId);
      const added: string[] = [];
      for (const part of parts) {
        const saved = yield* ops.addCard(
          sessionId,
          { ...part, dependsOn: [...card.dependsOn, ...part.dependsOn] },
          author,
        );
        if (Option.isSome(saved)) added.push(saved.value.id);
      }
      yield* ops.replaceCards(sessionId, [cardId], added, author);
      yield* retire(goal, [cardId]);
      yield* orchestrator.poke(goal.goalInstanceId);
      return { cardIds: added };
    }),

    /** Replaces cards that are not running with one card that does all of them. */
    mergeCards: Effect.fn("KanbanBoardActions.mergeCards")(function* (
      sessionId: string,
      cardIds: readonly string[],
      merged: CardDraft,
      author: BoardAuthor,
    ) {
      const goal = yield* board(sessionId);
      const cards = yield* Effect.forEach(cardIds, (cardId) => idle(sessionId, cardId));
      const ids = new Set(cardIds);
      const dependsOn = [
        ...new Set([...cards.flatMap((card) => card.dependsOn), ...merged.dependsOn]),
      ].filter((id) => !ids.has(id));
      const saved = yield* ops.addCard(sessionId, { ...merged, dependsOn }, author);
      const added = Option.map(saved, (card) => card.id);
      yield* ops.replaceCards(sessionId, cardIds, Option.toArray(added), author);
      yield* retire(goal, cardIds);
      yield* orchestrator.poke(goal.goalInstanceId);
      return { cardId: Option.getOrNull(added) };
    }),

    /** Takes a card off the board, stopping its attempt; its work stays on the card branch. */
    cancelCard: Effect.fn("KanbanBoardActions.cancelCard")(function* (
      sessionId: string,
      cardId: string,
      author: BoardAuthor,
    ) {
      const goal = yield* board(sessionId);
      const card = yield* cardOf(sessionId, cardId);
      yield* ops.cancelCard(sessionId, cardId, author);
      yield* closeDecisions(goal, [cardId], "card_stopped");
      // A running attempt ends as Stopped and the loop then settles the worktree.
      if (running(card)) yield* orchestrator.stopAttempt(goal.goalInstanceId, cardId);
      else yield* retire(goal, [cardId]);
      yield* orchestrator.poke(goal.goalInstanceId);
    }),

    moveCard,

    /**
     * Carries out what a person meant by dragging a card; the owner decides the card's status.
     * Reordering, change requests and cancelling work on any board. Requeueing and holding need
     * the kanban loop that assigns cards. An intent the card's state does not fit is refused.
     */
    applyIntent: Effect.fn("KanbanBoardActions.applyIntent")(function* (
      sessionId: string,
      intent: BoardIntent,
      author: BoardAuthor,
    ) {
      const card = yield* cardOf(sessionId, intent.cardId);
      const planVersion = (yield* workflows.get(sessionId)).plan?.version ?? 0;
      const kanban = yield* kanbanOf(sessionId);
      const poke = Option.match(kanban, {
        onNone: () => Effect.void,
        onSome: (goal) => orchestrator.poke(goal.goalInstanceId),
      });
      const applied = Effect.map(workflows.get(sessionId), (state): BoardEditResult =>
        BoardEditResult.Applied({ state }),
      );
      const hold = Effect.fnUntraced(function* (hold: boolean) {
        yield* board(sessionId);
        yield* workflows.holdCard(sessionId, { cardId: card.id, hold }, author);
        yield* poke;
        return yield* applied;
      });
      /**
       * Moves the card to another conversation's Plan of the same project. Only a card that is not
       * started, or blocked, goes: it is added there first (so a refused add leaves this Plan as
       * it was), then cancelled here, which keeps its earlier work on its card branch.
       */
      const transfer = Effect.fnUntraced(function* (toSessionId: string, at: string | null) {
        if (toSessionId === sessionId) return yield* refuse("transfer_target_invalid");
        if (running(card)) return yield* refuse("card_running");
        if (card.status === "human_decision") return yield* refuse("card_waiting");
        if (card.status === "done")
          return yield* BoardEditRefused.make({ reason: "card_finished" });
        const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
        if (steps.some((step) => step.id !== card.id && step.dependsOn.includes(card.id)))
          return yield* refuse("card_has_dependents");
        // Two reads, not `Effect.all` over a tuple: that contextual type loses the error types.
        const source = yield* sessions.get(sessionId);
        const target = yield* sessions.get(toSessionId).pipe(
          Effect.asSome,
          Effect.catchTag("SessionNotFound", () => Effect.succeedNone),
        );
        if (Option.isNone(target) || target.value.projectId !== source.projectId)
          return yield* refuse("transfer_target_invalid");
        const targetPlan = (yield* workflows.get(toSessionId)).plan;
        if (targetPlan === null) return yield* refuse("transfer_target_invalid");
        const before = at === null ? -1 : targetPlan.steps.findIndex((step) => step.id === at);
        const added = { planVersion: targetPlan.version, card: draftOf(card) };
        yield* workflows.editBoard(
          toSessionId,
          BoardEdit.cases.AddCard.make(before < 0 ? added : { ...added, index: before }),
          author,
        );
        yield* ops.cancelCard(sessionId, card.id, author);
        yield* Option.match(kanban, {
          onNone: () => Effect.void,
          onSome: (goal) => retire(goal, [card.id]),
        });
        yield* poke;
        const targetKanban = yield* kanbanOf(toSessionId);
        yield* Option.match(targetKanban, {
          onNone: () => Effect.void,
          onSome: (goal) => orchestrator.poke(goal.goalInstanceId),
        });
        return yield* applied;
      });
      return yield* Match.valueTags(intent, {
        /** The card takes the place of `at` in its own Plan: cards are ordered inside their Goal. */
        Reorder: Effect.fnUntraced(function* ({ at }) {
          const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
          const index = steps.findIndex((step) => step.id === at);
          const target = steps[index];
          if (target === undefined) return yield* refuse("card_missing");
          if (target.status !== card.status) return yield* refuse("reorder_across_columns");
          const result = yield* workflows.editBoard(
            sessionId,
            BoardEdit.cases.MoveCard.make({ planVersion, cardId: card.id, index }),
            author,
          );
          yield* poke;
          return result;
        }),
        Requeue: Effect.fnUntraced(function* () {
          yield* board(sessionId);
          if (card.status !== "blocked") return yield* refuse("card_not_blocked");
          // A dead-lettered attempt continues as the same queue item; any other blocked card
          // starts a new failure streak from ready.
          if (!(yield* orchestrator.requeue(sessionId, card.id, author)))
            yield* moveCard(sessionId, { cardId: card.id, from: "blocked", to: "ready" }, author);
          return yield* applied;
        }),
        Hold: () => hold(true),
        Release: () => hold(false),
        ChangeRequest: ({ patch }) =>
          card.status !== "in_progress"
            ? Effect.fail(refuse("card_not_running"))
            : workflows.editBoard(
                sessionId,
                BoardEdit.cases.EditCard.make({ planVersion, cardId: card.id, patch }),
                author,
              ),
        Cancel: Effect.fnUntraced(function* () {
          const result = yield* workflows.editBoard(
            sessionId,
            BoardEdit.cases.CancelCard.make({ planVersion, cardId: card.id }),
            author,
          );
          // A stopped card's decision is closed, not answered: nobody refused it.
          if (Predicate.isTagged(result, "Applied") && Option.isSome(kanban))
            yield* closeDecisions(kanban.value, [card.id], "card_stopped");
          yield* poke;
          return result;
        }),
        Transfer: ({ toSessionId, at }) => transfer(toSessionId, at),
      });
    }),

    /** Settles a user's pending change to an executing card and records the decision. */
    settleChangeRequest: Effect.fn("KanbanBoardActions.settleChangeRequest")(function* (
      sessionId: string,
      requestId: number,
      decision: ChangeDecision,
      author: BoardAuthor,
    ) {
      const goal = yield* board(sessionId);
      const request = yield* Effect.fromOption(
        yield* attempts.changeRequest(sessionId, requestId),
      ).pipe(Effect.mapError(() => refuse("request_missing")));
      if (request.status !== "pending") return yield* refuse("request_settled");
      const change: UserChange = request.change_json;
      const settle = (status: "applied" | "reassigned" | "rejected", reason: string | null) =>
        attempts.settleChangeRequest(requestId, { status, reason });
      const apply = Effect.fnUntraced(function* (fresh: boolean) {
        yield* UserChange.match(change, {
          Cancel: () =>
            fresh
              ? Effect.fail(refuse("reassign_needs_edit"))
              : Effect.gen(function* () {
                  const card = yield* cardOf(sessionId, request.card_id);
                  yield* ops.cancelCard(sessionId, card.id, author);
                  yield* closeDecisions(goal, [card.id], "card_stopped");
                  if (running(card)) yield* orchestrator.stopAttempt(goal.goalInstanceId, card.id);
                  else yield* retire(goal, [card.id]);
                }),
          Edit: ({ patch }) =>
            Effect.flatMap(cardOf(sessionId, request.card_id), (card) =>
              amend(
                goal,
                card,
                patch,
                `The user changed this card (${describePatch(patch)}).`,
                author,
                fresh,
              ),
            ),
        });
        yield* settle(fresh ? "reassigned" : "applied", null);
        yield* orchestrator.poke(goal.goalInstanceId);
        return { status: fresh ? ("reassigned" as const) : ("applied" as const) };
      });
      return yield* Match.valueTags(decision, {
        Reject: ({ reason }) =>
          Effect.as(settle("rejected", reason), { status: "rejected" as const }),
        Apply: () => apply(false),
        Reassign: () => apply(true),
      });
    }),

    /**
     * Applies the orchestrator's verdicts on every card against the changed Goal, then lets cards
     * be assigned again. A card without a verdict continues.
     */
    applyGoalChange: Effect.fn("KanbanBoardActions.applyGoalChange")(function* (
      sessionId: string,
      verdicts: readonly GoalChangeVerdict[],
      author: BoardAuthor,
    ) {
      const goal = yield* board(sessionId);
      if (goal.hold === null) return yield* refuse("no_goal_change");
      const hold = goal.hold;
      yield* Effect.forEach(
        verdicts,
        Effect.fnUntraced(function* (verdict) {
          const card = yield* cardOf(sessionId, verdict.cardId);
          yield* Match.valueTags(verdict, {
            Continue: () => Effect.void,
            Amend: ({ patch, note }) => amend(goal, card, patch, note, author, false),
            Stop: ({ reason }) =>
              Effect.gen(function* () {
                yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
                  ...current,
                  reason: CardHoldReason.cases.GoalChanged.make({ note: reason }),
                }));
                yield* closeDecisions(goal, [card.id], "card_stopped");
                if (running(card))
                  return yield* interrupt(
                    goal,
                    card,
                    "blocked",
                    `card ${card.id} stopped: ${reason}`,
                    author,
                  );
                if (card.status === "blocked" || card.status === "done") return;
                return yield* workflows.transitionCard(
                  sessionId,
                  {
                    cardId: card.id,
                    from: card.status,
                    to: "blocked",
                    detail: `card ${card.id} stopped: ${reason}`,
                  },
                  author,
                );
              }),
            Replace: ({ card: draft }) =>
              Effect.gen(function* () {
                yield* closeDecisions(goal, [card.id], "card_stopped");
                const replacement = yield* ops.addCard(sessionId, draft, author);
                yield* ops.replaceCards(
                  sessionId,
                  [card.id],
                  Option.toArray(Option.map(replacement, (added) => added.id)),
                  author,
                );
                // The replaced card's branch stays for the new card to consult.
                if (running(card))
                  return yield* orchestrator.stopAttempt(goal.goalInstanceId, card.id);
                return yield* retire(goal, [card.id]);
              }),
            NeedsDecision: ({ question }) =>
              Effect.gen(function* () {
                yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
                  ...current,
                  reason: CardHoldReason.cases.GoalChanged.make({ note: question }),
                }));
                if (card.status === "done") return;
                // The request moves the card first, so a running attempt then ends as Stopped. One
                // Goal change asks about a card once.
                yield* decisions.request({
                  sessionId,
                  goalInstanceId: goal.goalInstanceId,
                  cardId: card.id,
                  key: `impact_unclear:${hold.fromVersion}:${hold.toVersion}`,
                  kind: DecisionKind.cases.ImpactUnclear.make({
                    fromGoalVersion: hold.fromVersion,
                    toGoalVersion: hold.toVersion,
                  }),
                  author,
                });
                if (running(card))
                  return yield* orchestrator.stopAttempt(goal.goalInstanceId, card.id);
              }),
          });
        }),
        { discard: true },
      );
      yield* attempts.setHold(goal.goalInstanceId, null, hold.toVersion);
      yield* orchestrator.poke(goal.goalInstanceId);
      return { goalVersion: hold.toVersion };
    }),

    /**
     * The session's kanban board as the loop sees it: why it stopped each card and which blocked
     * cards can be requeued. None when the session's Goal does not run as a board.
     */
    view: Effect.fn("KanbanBoardActions.view")(function* (sessionId: string) {
      const goal = yield* kanbanOf(sessionId);
      if (Option.isNone(goal)) return Option.none<KanbanBoardView>();
      const { goalInstanceId, mode, hold } = goal.value;
      const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
      const dead = new Set(
        (yield* attempts.deadLettered(cardQueueName))
          .filter((item) => item.goalInstanceId === goalInstanceId)
          .map((item) => item.cardId),
      );
      const cards = yield* Effect.forEach(steps, (card) =>
        Effect.map(attempts.ladder(goalInstanceId, card.id), (ladder): KanbanCardView => ({
          cardId: card.id,
          status: card.status,
          reason: ladder.reason,
          failures: ladder.failureStreak,
          replans: ladder.replans,
          resolutionOf: ladder.resolutionOf,
          requeueable: card.status === "blocked" && dead.has(card.id),
        })),
      );
      return Option.some<KanbanBoardView>({
        goalInstanceId,
        mode,
        goalChange: hold,
        cards,
        schedule: yield* scheduleView(goal.value),
        loop: yield* health.get(goalInstanceId),
      });
    }),

    /**
     * Sets the Goals of the project this Goal waits for; it takes no slots until they merge. An
     * empty list lifts the wait. A cycle is refused.
     */
    setDependencies: Effect.fn("KanbanBoardActions.setDependencies")(function* (
      sessionId: string,
      dependsOn: readonly string[],
    ) {
      const goal = yield* board(sessionId);
      return yield* scheduler.setDependencies(goal.goalInstanceId, dependsOn);
    }),

    /** Runs the board's loop again after it stopped on exhausted retries or a defect. */
    restartLoop: Effect.fn("KanbanBoardActions.restartLoop")(function* (sessionId: string) {
      const goal = yield* board(sessionId);
      yield* orchestrator.restart({ sessionId, goalInstanceId: goal.goalInstanceId });
    }),

    /** Puts a dead-lettered card back on the queue. */
    requeueCard: (sessionId: string, cardId: string, author: BoardAuthor) =>
      orchestrator.requeue(sessionId, cardId, author),
  };
});

/** Board actions of the kanban orchestrator. */
export class KanbanBoardActions extends Context.Service<
  KanbanBoardActions,
  Effect.Success<typeof make>
>()("memory-agent/kanban/board-actions/KanbanBoardActions") {
  static readonly layer = Layer.effect(KanbanBoardActions, make);
}
