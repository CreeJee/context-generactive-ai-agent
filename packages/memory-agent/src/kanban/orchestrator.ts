import {
  Clock,
  Context,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
  Struct,
} from "effect";
import { WorkflowEngine } from "effect/workflow";
import { AppEvents } from "../events/app-events.ts";
import { Projects } from "../projects/projects.ts";
import { Sessions } from "../sessions/sessions.ts";
import type { BoardEditRefused } from "../workflow/board-edit.ts";
import type { BoardAuthor, CardStatus } from "../workflow/card.ts";
import { Workflows, type PlanStep, type WorkflowState } from "../workflow/workflow.ts";
import { CardVerifier } from "./card-agent.ts";
import {
  CardAttempts,
  type CardAttempt,
  type CardAttemptOutcome,
  type CardLadder,
  type KanbanGoal,
} from "./card-attempts.ts";
import {
  CardAttemptExecution,
  cardQueueName,
  CardRuns,
  type CardRunPayload,
} from "./card-queue.ts";
import { PersistedQueueItems } from "./persisted-queue-store.ts";
import { boardOps } from "./board-ops.ts";
import { CardWorktrees, type CardRef } from "./worktree.ts";
import {
  HumanDecisions,
  type DecisionAnswer,
  type DecisionKind,
  type HumanDecisionRequest,
} from "./human-decision.ts";
import { GoalSchedules } from "./goal-schedules.ts";
import { failureCode, worktreeFailure, type CardFailure } from "./failures.ts";
import { loopStopped } from "../runtime/loop-health.ts";
import { BoardHealth, type BoardRef } from "./board-health.ts";
import { GoalMerges } from "./merge-queue.ts";
import { overlappingBoundaries, ProjectScheduler } from "./scheduler.ts";

/**
 * The Goal orchestrator loop of a kanban board (docs/kanban-orchestration.md "오케스트레이터
 * 루프"). It is deterministic: it assigns Ready cards, takes up attempt outcomes, verifies and
 * integrates finished cards, and climbs the failure ladder. Judgements it cannot make (replanning,
 * user change requests, a changed Goal) are raised as attention for the orchestrator model, which
 * answers with the board tools in `orchestrator-tools.ts`.
 *
 * Everything it acts on is stored, so a restarted owner continues from the board and the attempt
 * records; nothing it did is replayed.
 */

/** Why the orchestrator model is needed on a board. */
export const KanbanAttentionReason = Schema.Literals([
  "goal_changed",
  "replan_requested",
  "change_requested",
  "cards_done",
  "file_overlap",
  "goal_unverified",
  "upstream_regressed",
]);
export type KanbanAttentionReason = typeof KanbanAttentionReason.Type;

export interface KanbanAttention {
  readonly sessionId: string;
  readonly goalInstanceId: string;
  readonly reasons: readonly KanbanAttentionReason[];
}

export class KanbanStartRefused extends Schema.TaggedError<KanbanStartRefused>()(
  "KanbanStartRefused",
  {
    reason: Schema.Literals(["goal_missing", "plan_not_executing", "worktree_unavailable"]),
  },
) {}

/** How a repeated failure of a card is answered, by its place on the ladder. */
export type FailureStep =
  | { readonly _tag: "Retry" }
  | { readonly _tag: "Backoff"; readonly delay: Duration.Duration }
  | { readonly _tag: "Replan" }
  | { readonly _tag: "HumanDecision" };

/**
 * Retry, then a longer backoff, then a request to replan the card, then a person. The streak
 * counts consecutive failures; a replanned card starts a new streak and goes to a person next time.
 */
const failureStep = (ladder: CardLadder, backoff: Duration.Duration): FailureStep =>
  ladder.failureStreak <= 1
    ? { _tag: "Retry" }
    : ladder.failureStreak === 2
      ? { _tag: "Backoff", delay: backoff }
      : ladder.replans === 0
        ? { _tag: "Replan" }
        : { _tag: "HumanDecision" };

/** Two cards' expected files overlap when one boundary is the other or lies below it. */
const boundariesOverlap = (left: PlanStep, right: PlanStep) =>
  overlappingBoundaries(left, right).length > 0;

export interface KanbanOrchestratorOptions {
  /** Longest wait between looks at a board when nothing in this process woke it. */
  readonly pollInterval?: Duration.Input;
  /** The wait before a card's second retry. */
  readonly backoff?: Duration.Input;
}

const loopAuthor = (goalInstanceId: string): BoardAuthor => ({
  _tag: "Orchestrator",
  runId: `kanban:${goalInstanceId}`,
});

/** A squash attempt or Goal sync, read as what the loop does next. */
type Integration =
  | { readonly _tag: "Integrated"; readonly commit: string | null }
  | { readonly _tag: "GoalAdvanced" }
  | { readonly _tag: "Synced" }
  | { readonly _tag: "Conflict"; readonly files: readonly string[] }
  | { readonly _tag: "Failed"; readonly failure: CardFailure };

const make = (options: KanbanOrchestratorOptions) =>
  Effect.gen(function* () {
    const attempts = yield* CardAttempts;
    const workflows = yield* Workflows;
    const ops = boardOps(workflows);
    const worktrees = yield* CardWorktrees;
    const verifier = yield* CardVerifier;
    const runs = yield* CardRuns;
    const items = yield* PersistedQueueItems;
    const sessions = yield* Sessions;
    const projects = yield* Projects;
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const events = yield* AppEvents;
    const decisions = yield* HumanDecisions;
    const scheduler = yield* ProjectScheduler;
    const merges = yield* GoalMerges;
    const schedules = yield* GoalSchedules;
    const health = yield* BoardHealth;
    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? Duration.seconds(5));
    const backoff = Duration.fromInputUnsafe(options.backoff ?? Duration.minutes(2));
    const loops = yield* FiberMap.make<string>();
    const integrations = yield* FiberMap.make<string>();
    const pokes = yield* PubSub.unbounded<string>();
    const attention = yield* PubSub.unbounded<KanbanAttention>();
    const announced = yield* Ref.make<Readonly<Record<string, string>>>({});
    // Looks at boards and requeues take turns, so neither acts on a dead letter the other is
    // settling. Neither waits on an agent or verifier inside it.
    const looking = yield* Semaphore.make(1);
    // The scheduler wakes boards whose share of the slots, dependencies or merges changed.
    yield* scheduler.wakeups.pipe(
      Stream.runForEach((goalInstanceId) => PubSub.publish(pokes, goalInstanceId)),
      Effect.forkScoped,
    );

    const cardRef = (goal: KanbanGoal, cardId: string): CardRef => ({
      projectRoot: goal.projectRoot,
      goalInstanceId: goal.goalInstanceId,
      cardId,
    });
    const stepOf = (state: WorkflowState, cardId: string) =>
      Option.fromUndefinedOr(state.plan?.steps.find((step) => step.id === cardId));

    /**
     * Moves a card the loop saw in `from`. A card someone moved meanwhile stays where they put it;
     * the next look at the board continues from there.
     */
    const move = (
      goal: KanbanGoal,
      cardId: string,
      from: CardStatus,
      to: CardStatus,
      detail: string,
    ) =>
      workflows
        .transitionCard(
          goal.sessionId,
          { cardId, from, to, detail },
          loopAuthor(goal.goalInstanceId),
        )
        .pipe(
          Effect.tap(() => events.publishSession(goal.sessionId, "run-state")),
          Effect.as(true),
          Effect.catchTag("BoardEditRefused", (refused: BoardEditRefused) => {
            switch (refused.reason) {
              case "card_status_changed":
              case "card_missing":
                return Effect.succeed(false);
              default:
                return Effect.fail(refused);
            }
          }),
        );

    /** The card's latest attempt, the one whose outcome the loop is acting on. */
    const latestAttempt = (goal: KanbanGoal, cardId: string) =>
      Effect.map(attempts.nextAttemptNo(goal.goalInstanceId, cardId), (next) => next - 1);

    /**
     * Asks a person about a card the loop saw in `from`; the request moves the card to
     * `human_decision`. The key names the occasion, so taking up the same occasion again returns
     * the existing request instead of asking twice. A card someone moved meanwhile stays put.
     */
    const askPerson = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      cardId: string,
      from: CardStatus,
      key: string,
      kind: DecisionKind,
    ) {
      const card = stepOf(yield* workflows.get(goal.sessionId), cardId);
      if (!Option.exists(card, (step) => step.status === from || step.status === "human_decision"))
        return;
      yield* decisions
        .request({
          sessionId: goal.sessionId,
          goalInstanceId: goal.goalInstanceId,
          cardId,
          key,
          kind,
          author: loopAuthor(goal.goalInstanceId),
        })
        .pipe(
          Effect.catchTags({
            HumanDecisionRefused: (refused) => {
              switch (refused.reason) {
                case "goal_superseded":
                case "card_missing":
                  return Effect.void;
                default:
                  return Effect.fail(refused);
              }
            },
            BoardEditRefused: (refused) => {
              switch (refused.reason) {
                case "card_status_changed":
                case "card_missing":
                  return Effect.void;
                default:
                  return Effect.fail(refused);
              }
            },
          }),
        );
    });

    /** Offers the card's next attempt with the Goal and Plan versions it runs against. */
    const offer = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      state: WorkflowState,
      card: PlanStep,
    ) {
      const attemptNo = yield* attempts.nextAttemptNo(goal.goalInstanceId, card.id);
      const ladder = yield* attempts.updateLadder(
        goal.goalInstanceId,
        card.id,
        (current) => current,
      );
      const payload = {
        sessionId: goal.sessionId,
        goalInstanceId: goal.goalInstanceId,
        cardId: card.id,
        attemptNo,
        goalVersion: state.goal?.version ?? goal.goalVersion,
        planVersion: state.plan?.version ?? 0,
        notes: ladder.notes,
      };
      yield* attempts.open(payload);
      yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
        ...current,
        notBefore: null,
        reason: null,
      }));
      yield* start(payload);
      // The notes travel in the payload and leave the ladder only once the attempt started, so an
      // owner dying in between offers them again on restart. Notes added meanwhile stay.
      yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
        ...current,
        notes: current.notes.slice(payload.notes.length),
      }));
    });

    /** Starts an opened attempt's workflow; one already started is not offered again. */
    const start = (payload: CardRunPayload) =>
      CardAttemptExecution.execute(payload, { discard: true }).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      );

    /** A failed attempt or verification climbs the card's ladder. */
    const failCard = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      cardId: string,
      from: CardStatus,
      failure: CardFailure,
    ) {
      const code = failureCode(failure);
      const ladder = yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
        ...current,
        failureStreak: current.failureStreak + 1,
      }));
      const step = failureStep(ladder, backoff);
      const now = yield* Clock.currentTimeMillis;
      switch (step._tag) {
        case "Retry":
          yield* move(goal, cardId, from, "ready", `card ${cardId} failed (${code}); retrying`);
          return;
        case "Backoff":
          yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
            ...current,
            notBefore: now + Duration.toMillis(step.delay),
            reason: { _tag: "RetryBackoff", failure },
          }));
          yield* move(
            goal,
            cardId,
            from,
            "ready",
            `card ${cardId} failed again (${code}); waiting`,
          );
          return;
        case "Replan":
          yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
            ...current,
            reason: { _tag: "ReplanRequested", failure },
          }));
          yield* move(
            goal,
            cardId,
            from,
            "blocked",
            `card ${cardId} keeps failing (${code}); replan`,
          );
          return;
        case "HumanDecision": {
          yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
            ...current,
            reason: { _tag: "RepeatedFailure", failure },
          }));
          const attemptNo = yield* latestAttempt(goal, cardId);
          yield* askPerson(goal, cardId, from, `retry_exhausted:${attemptNo}`, {
            _tag: "RetryExhausted",
            attempts: attemptNo,
          });
          return;
        }
      }
    });

    const squash = (goal: KanbanGoal, card: PlanStep) =>
      worktrees.squashIntoGoal(cardRef(goal, card.id), card.title).pipe(
        Effect.map((result): Integration => {
          switch (result._tag) {
            case "Integrated":
            case "AlreadyIntegrated":
              return { _tag: "Integrated", commit: result.commit };
            case "NoChanges":
              return { _tag: "Integrated", commit: null };
          }
        }),
        Effect.catchTag("CardWorktreeFailed", (failure) =>
          Effect.succeed<Integration>(
            failure.reason._tag === "GoalAdvanced"
              ? { _tag: "GoalAdvanced" }
              : { _tag: "Failed", failure: worktreeFailure(failure) },
          ),
        ),
      );
    const sync = (goal: KanbanGoal, card: PlanStep) =>
      worktrees.syncWithGoal(cardRef(goal, card.id)).pipe(
        Effect.as<Integration>({ _tag: "Synced" }),
        Effect.catchTags({
          CardIntegrationConflict: (conflict) =>
            Effect.succeed<Integration>({ _tag: "Conflict", files: conflict.files }),
          CardWorktreeFailed: (failure) =>
            Effect.succeed<Integration>({ _tag: "Failed", failure: worktreeFailure(failure) }),
        }),
      );

    /**
     * A conflicting card is re-applied by a resolution card on the current Goal branch, which takes
     * its place in the Plan. A resolution card that conflicts again goes to a person.
     */
    const resolveConflict = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      card: PlanStep,
      files: readonly string[],
    ) {
      const ladder = yield* attempts.ladder(goal.goalInstanceId, card.id);
      const listed = files.join(", ");
      if (ladder.resolutionOf !== null) {
        yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
          ...current,
          reason: { _tag: "MergeConflict", files },
        }));
        const attemptNo = yield* latestAttempt(goal, card.id);
        // A person who answered sends the card on; a conflict after that is a new occasion.
        const answered = (yield* decisions.forCard(
          goal.sessionId,
          goal.goalInstanceId,
          card.id,
        )).filter(
          (request) =>
            request.kind._tag === "IntegrationConflict" && request.state._tag === "Answered",
        ).length;
        yield* askPerson(goal, card.id, "verify", `integration_conflict:${attemptNo}:${answered}`, {
          _tag: "IntegrationConflict",
          files,
        });
        return;
      }
      const author = loopAuthor(goal.goalInstanceId);
      const resolution = yield* ops.addCard(
        goal.sessionId,
        {
          title: `Resolve conflicts: ${card.title}`,
          description: `Card ${card.id} could not join the Goal branch because ${listed} changed there too. Re-apply its change on the current Goal branch. Its work is on branch ctx/card/${goal.goalInstanceId}/${card.id}; read it with read-only git commands (git diff, git show). Do not commit; the owner commits your work.\n\n${card.description}`,
          dependsOn: card.dependsOn,
          acceptanceCriteria: card.acceptanceCriteria,
          ...Struct.pick(card, ["outcome", "boundaries", "requiredEvidence"]),
        },
        author,
      );
      if (Option.isNone(resolution)) return;
      yield* attempts.updateLadder(goal.goalInstanceId, resolution.value.id, (current) => ({
        ...current,
        resolutionOf: card.id,
      }));
      // The conflicting card's branch stays as the resolution card's reference.
      yield* ops.replaceCards(goal.sessionId, [card.id], [resolution.value.id], author);
      if (goal.mode === "worktree")
        yield* worktrees.settle(cardRef(goal, card.id), { _tag: "Cancelled" });
    });

    /** Verifies a finished card and puts it on the Goal branch, syncing when the Goal moved. */
    const verifyAndIntegrate = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      cardId: string,
      report: string,
    ) {
      /**
       * The card while it is still in verify and no changed Goal holds integration. A changed Goal
       * pauses integration at this boundary; the card is verified again after the cards are
       * classified against it.
       */
      const verifying = Effect.gen(function* () {
        const card = Option.getOrUndefined(stepOf(yield* workflows.get(goal.sessionId), cardId));
        const held = Option.exists(
          yield* attempts.goal(goal.goalInstanceId),
          (current) => current.hold !== null,
        );
        return card?.status === "verify" && !held ? card : undefined;
      });
      // Each round verifies the card as it now is; a sync with a moved Goal branch needs another.
      for (let round = 0; round < 3; round++) {
        const card = yield* verifying;
        if (card === undefined) return;
        const verdict = yield* verifier.verify({
          sessionId: goal.sessionId,
          projectId: goal.projectId,
          goalInstanceId: goal.goalInstanceId,
          card,
          worktree: Option.getOrNull(
            goal.mode === "worktree" ? yield* worktrees.find(cardRef(goal, cardId)) : Option.none(),
          ),
          report,
        });
        // A card amended or held while it was verified: the verdict is about work that no longer
        // counts, so nothing joins the Goal branch on it.
        if ((yield* verifying) === undefined) return;
        switch (verdict._tag) {
          case "Failed":
            return yield* failCard(goal, cardId, "verify", {
              _tag: "Verification",
              verdict: verdict.failure,
            });
          case "Passed":
            break;
        }
        let integration: Integration =
          goal.mode === "worktree"
            ? yield* squash(goal, card)
            : { _tag: "Integrated", commit: null };
        if (integration._tag === "GoalAdvanced") integration = yield* sync(goal, card);
        switch (integration._tag) {
          case "Integrated": {
            const moved = yield* move(
              goal,
              cardId,
              "verify",
              "done",
              `card ${cardId} integrated${integration.commit === null ? " (no changes)" : ` as ${integration.commit}`}; evidence: ${verdict.evidence.join("; ")}`,
            );
            if (moved && goal.mode === "worktree")
              yield* worktrees.settle(cardRef(goal, cardId), { _tag: "Done" });
            yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
              ...current,
              failureStreak: 0,
              reason: null,
            }));
            return;
          }
          case "Synced":
          case "GoalAdvanced":
            continue;
          case "Conflict":
            return yield* resolveConflict(goal, card, integration.files);
          case "Failed":
            return yield* failCard(goal, cardId, "verify", integration.failure);
        }
      }
      return yield* failCard(goal, cardId, "verify", { _tag: "GoalBranchKeptMoving" });
    });

    /** Runs a card's verification and integration once, beside the loop. */
    const startIntegration = (goal: KanbanGoal, cardId: string, report: string) =>
      FiberMap.run(
        integrations,
        `${goal.goalInstanceId}:${cardId}`,
        verifyAndIntegrate(goal, cardId, report).pipe(
          // The card stays in verify. A failure that outlasts the retries stops the board, and the
          // look after a restart starts the integration again.
          health.supervise(goal, "Kanban card integration stopped", { cardId }),
          Effect.ensuring(PubSub.publish(pokes, goal.goalInstanceId)),
        ),
        { onlyIfMissing: true },
      );

    /** Takes up one recorded outcome. */
    const takeUp = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      state: WorkflowState,
      attempt: CardAttempt,
      outcome: CardAttemptOutcome,
    ) {
      const card = stepOf(state, attempt.cardId);
      switch (outcome._tag) {
        case "Superseded":
          break;
        case "Stopped":
          // Whoever stopped the attempt already moved the card. A card taken off the board keeps
          // its work on the card branch.
          if (Option.isNone(card) && goal.mode === "worktree")
            yield* worktrees.settle(cardRef(goal, attempt.cardId), { _tag: "Cancelled" });
          break;
        case "Fenced":
          yield* attempts.updateLadder(goal.goalInstanceId, attempt.cardId, (current) => ({
            ...current,
            reason: { _tag: "UncertainEffect", runId: outcome.runId },
          }));
          yield* askPerson(
            goal,
            attempt.cardId,
            "in_progress",
            `uncertain_side_effect:${outcome.runId}:${attempt.attemptNo}`,
            { _tag: "UncertainSideEffect", runId: outcome.runId, toolNames: [] },
          );
          break;
        case "Failed":
          yield* failCard(goal, attempt.cardId, "in_progress", outcome.failure);
          break;
        case "Completed":
          // Work done against an earlier Goal waits until the cards are classified against it.
          if (goal.hold !== null) return false;
          if (
            yield* move(
              goal,
              attempt.cardId,
              "in_progress",
              "verify",
              `card ${attempt.cardId} finished`,
            )
          )
            yield* startIntegration(goal, attempt.cardId, outcome.report);
          break;
      }
      return true;
    });

    /**
     * What an answer asks beyond the card's move, which the answer already made as the user: a
     * cleared fence, a fresh failure streak, a note for the next attempt, or a replan request.
     */
    const followAnswer = (
      goal: KanbanGoal,
      request: HumanDecisionRequest,
      answer: DecisionAnswer,
    ) => {
      const resume = (note: string | null) =>
        attempts.updateLadder(goal.goalInstanceId, request.cardId, (current) => ({
          ...current,
          reason: null,
          notes: note === null ? current.notes : [...current.notes, note],
        }));
      switch (answer._tag) {
        case "RetryExhausted":
          switch (answer.choice) {
            case "requeue":
              return attempts.updateLadder(goal.goalInstanceId, request.cardId, (current) => ({
                ...current,
                failureStreak: 0,
                notBefore: null,
                reason: null,
              }));
            case "stop":
              return Effect.void;
          }
        case "UncertainSideEffect": {
          // Only the person's answer clears a fence; the run's effects stay unknown to the loop.
          const acknowledge = (note: string) => {
            switch (request.kind._tag) {
              case "UncertainSideEffect":
                return Effect.andThen(attempts.acknowledgeRun(request.kind.runId), resume(note));
              default:
                return resume(note);
            }
          };
          switch (answer.choice) {
            case "continue":
              return acknowledge(
                "A person checked the earlier run whose effects were unknown and found its work in place. Continue from the worktree as it is.",
              );
            case "retry":
              return acknowledge(
                "A person checked the earlier run whose effects were unknown and found its work missing. Check the worktree and do that work again.",
              );
            case "stop":
              return Effect.void;
          }
        }
        case "IntegrationConflict":
          switch (answer.choice) {
            // The card is in verify again; the loop verifies and integrates it.
            case "resolved":
              return resume(null);
            case "rework":
              return resume(
                "A person asked to rework this card because it conflicted with the Goal branch. Re-apply its change on the current Goal branch.",
              );
            case "stop":
              return Effect.void;
          }
        case "ImpactUnclear":
          switch (answer.choice) {
            case "continue":
              return resume(null);
            // The orchestrator model replaces the card, as for any replan request.
            case "replace":
              return attempts.updateLadder(goal.goalInstanceId, request.cardId, (current) => ({
                ...current,
                reason: { _tag: "ReplanRequested", failure: null },
              }));
            case "stop":
              return Effect.void;
          }
        // The answer moved the card back to ready; the assignment reads the choice from the request.
        case "FileOverlap":
          return resume(null);
        // Goal-level answers are the merge queue's to follow.
        case "ProtectedBranchMerge":
        case "MergeConflict":
          return Effect.void;
      }
    };

    /** Follows each answered request of the board once, before cards are assigned. */
    const followAnswers = Effect.fnUntraced(function* (goal: KanbanGoal) {
      const followed = yield* attempts.followedDecisions(goal.goalInstanceId);
      const answered = (yield* decisions.forGoal(goal.sessionId, goal.goalInstanceId)).flatMap(
        (request) => {
          switch (request.state._tag) {
            case "Answered":
              return followed.has(request.requestId)
                ? []
                : [{ request, answer: request.state.answer }];
            case "Pending":
            case "Closed":
              return [];
          }
        },
      );
      yield* Effect.forEach(
        answered.toReversed(),
        ({ request, answer }) =>
          Effect.andThen(
            followAnswer(goal, request, answer),
            attempts.markDecisionFollowed(request),
          ),
        { discard: true },
      );
    });

    /** Turns dead-lettered attempts of the Goal into blocked cards a person or the model requeues. */
    const blockDeadLetters = Effect.fnUntraced(function* (goal: KanbanGoal) {
      const dead = (yield* attempts.deadLettered(cardQueueName)).filter(
        (item) => item.goalInstanceId === goal.goalInstanceId,
      );
      yield* Effect.forEach(
        dead,
        Effect.fnUntraced(function* (item) {
          const attempt = yield* attempts.attempt(item);
          if (Option.isNone(attempt) || attempt.value.handled) return;
          yield* attempts.updateLadder(goal.goalInstanceId, item.cardId, (current) => ({
            ...current,
            reason: { _tag: "DeadLettered" },
          }));
          yield* move(
            goal,
            item.cardId,
            "in_progress",
            "blocked",
            `card ${item.cardId} ran out of deliveries; requeue it from the board`,
          );
          yield* attempts.markHandled(item);
        }),
        { discard: true },
      );
    });

    /** One look at a board: take up outcomes, then assign what may run. */
    const tick = Effect.fnUntraced(function* (goalInstanceId: string) {
      const found = yield* attempts.goal(goalInstanceId);
      if (Option.isNone(found) || !found.value.active) return "stopped" as const;
      let goal = found.value;
      if ((yield* workflows.goalInstanceId(goal.sessionId)) !== goalInstanceId) {
        // A new Goal took over the session; this board's items complete as Superseded and its
        // people's waits close.
        yield* attempts.stopGoal(goalInstanceId);
        yield* decisions.closeSuperseded(goal.sessionId);
        yield* scheduler.forget(goalInstanceId);
        yield* scheduler.clearNotices(goalInstanceId);
        return "stopped" as const;
      }
      let state = yield* workflows.get(goal.sessionId);
      const reasons: KanbanAttentionReason[] = [];
      const goalVersion = state.goal?.version ?? goal.goalVersion;
      if (goalVersion > goal.goalVersion && goal.hold === null) {
        const hold = {
          _tag: "GoalChanged" as const,
          fromVersion: goal.goalVersion,
          toVersion: goalVersion,
        };
        yield* attempts.setHold(goalInstanceId, hold, goal.goalVersion);
        goal = { ...goal, hold };
      }
      if (goal.hold !== null) reasons.push("goal_changed");

      yield* blockDeadLetters(goal);
      const open = yield* attempts.pending(goalInstanceId);
      yield* Effect.forEach(
        open,
        Effect.fnUntraced(function* (attempt) {
          if (attempt.outcome === null) return;
          if (yield* takeUp(goal, state, attempt, attempt.outcome))
            yield* attempts.markHandled(attempt);
        }),
        { discard: true },
      );

      state = yield* workflows.get(goal.sessionId);
      // After reading the board: an answer is stored before it moves its card, so every card an
      // answer moved in this board is followed before it can be assigned.
      yield* followAnswers(goal);
      const steps = state.plan?.steps ?? [];
      const ladders = new Map<string, CardLadder>();
      for (const step of steps)
        ladders.set(step.id, yield* attempts.ladder(goalInstanceId, step.id));
      const replanning = steps
        .filter(
          (step) =>
            step.status === "blocked" && ladders.get(step.id)?.reason?._tag === "ReplanRequested",
        )
        .map((step) => step.id);
      if (replanning.length > 0) reasons.push("replan_requested");
      const requests = yield* attempts.pendingChangeRequests(goal.sessionId);
      if (requests > 0) reasons.push("change_requested");
      if (steps.length > 0 && steps.every((step) => step.status === "done"))
        reasons.push("cards_done");

      // Cards in verify that no integration is working on (after a restart, or a person moved
      // them there) are verified again.
      for (const step of steps)
        if (
          step.status === "verify" &&
          !(yield* FiberMap.has(integrations, `${goalInstanceId}:${step.id}`))
        )
          yield* startIntegration(goal, step.id, "");

      const executing = state.phase === "execute" && state.plan?.status === "executing";
      // A Goal waiting for another Goal's merge takes no slots; its cards stay where they are.
      const waitingOn = yield* scheduler.waitingOn(goalInstanceId);
      yield* scheduler.clearNotices(goalInstanceId);
      const planned: PlanStep[] = [];
      if (executing && goal.hold === null && waitingOn.length === 0) {
        const busy = new Set(
          (yield* attempts.pending(goalInstanceId)).map((attempt) => attempt.cardId),
        );
        const now = yield* Clock.currentTimeMillis;
        const working = steps.filter((step) => busy.has(step.id) || step.status === "verify");
        // A card a person or a restart left in_progress without an attempt continues first.
        const orphans = steps.filter((step) => step.status === "in_progress" && !busy.has(step.id));
        const ready = steps.filter(
          (step) =>
            step.status === "ready" &&
            !busy.has(step.id) &&
            (ladders.get(step.id)?.notBefore ?? 0) <= now,
        );
        for (const step of [...orphans, ...ready]) {
          // Expected files that overlap a working card wait for it; this is a hint, not a lock.
          if (
            [...working, ...planned].some(
              (other) => other.id !== step.id && boundariesOverlap(step, other),
            )
          )
            continue;
          const overlap = yield* scheduler.crossGoalOverlap(goal, step);
          switch (overlap._tag) {
            case "None":
              planned.push(step);
              break;
            // Another Goal's running card goes first; both boards hear about it.
            case "Running":
              yield* scheduler.notice(goalInstanceId, step.id, overlap);
              break;
            case "Waiting":
              break;
            // Another Goal finished these files but has not merged: a person picks the order.
            case "Unmerged":
              yield* askPerson(
                goal,
                step.id,
                step.status,
                `file_overlap:${overlap.otherGoalInstanceId}`,
                {
                  _tag: "FileOverlap",
                  otherGoalInstanceId: overlap.otherGoalInstanceId,
                  otherCardId: overlap.otherCardId,
                  files: overlap.files,
                },
              );
              break;
          }
        }
      }
      // Every look reports what it wants, so the scheduler can share the slots among the Goals.
      const granted = yield* scheduler.grant(goal, planned.length);
      for (const step of planned.slice(0, granted)) {
        const started =
          step.status === "in_progress" ||
          (yield* move(goal, step.id, "ready", "in_progress", `card ${step.id} assigned`));
        if (started) yield* offer(goal, state, step);
      }

      // Every card is done: the merge queue takes the Goal into its target branch.
      const schedule = yield* schedules.get(goalInstanceId);
      if (
        executing &&
        goal.hold === null &&
        steps.length > 0 &&
        steps.every((step) => step.status === "done")
      )
        yield* merges.offer(goal);
      if (Option.exists(schedule, (found) => found.upstreamPending))
        yield* merges.takeUpstream(goal);
      if (Option.exists(schedule, (found) => found.merge?._tag === "VerifyFailed"))
        reasons.push("goal_unverified");
      if (
        steps.some(
          (step) =>
            step.status === "done" && ladders.get(step.id)?.reason?._tag === "UpstreamRegressed",
        )
      )
        reasons.push("upstream_regressed");
      const notices = yield* scheduler.notices(goalInstanceId);
      if (notices.length > 0) reasons.push("file_overlap");

      // The model hears about a situation once; a later look finding the same one stays quiet.
      const situation = [
        reasons.join(","),
        goal.hold?.toVersion ?? "",
        replanning.join(","),
        requests,
        notices.join(","),
      ].join("|");
      const previous = yield* Ref.getAndUpdate(announced, (known) => ({
        ...known,
        [goalInstanceId]: situation,
      }));
      if (reasons.length > 0 && previous[goalInstanceId] !== situation)
        yield* PubSub.publish(attention, {
          sessionId: goal.sessionId,
          goalInstanceId,
          reasons,
        });
      return "running" as const;
    });

    /**
     * The board's loop: a look after every recorded outcome, poke or poll interval. A look that
     * fails is retried with backoff (`loopRetrySchedule`); the board and records are unchanged by
     * it. When the retries run out or a defect happens, here or in an integration or merge step
     * beside the loop, the loop stops and the board shows why until a person restarts it.
     */
    const loop = (board: BoardRef) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { goalInstanceId } = board;
          const wakeups = yield* PubSub.subscribe(pokes);
          yield* attempts.recordedOutcomes(goalInstanceId).pipe(
            Stream.runForEach(() => PubSub.publish(pokes, goalInstanceId)),
            Effect.forkScoped,
          );
          while (!loopStopped(yield* health.get(goalInstanceId))) {
            const step = yield* looking
              .withPermits(1)(tick(goalInstanceId))
              .pipe(health.supervise(board, "Kanban board look failed", {}));
            if (step._tag === "Stopped" || step.value === "stopped") return;
            yield* PubSub.take(wakeups).pipe(
              Effect.repeat({ until: (woken) => woken === goalInstanceId }),
              Effect.timeoutOption(pollInterval),
            );
          }
        }),
      );

    const run = (board: BoardRef) =>
      FiberMap.run(loops, board.goalInstanceId, loop(board), { onlyIfMissing: true });

    /**
     * Offers attempts whose workflow never started, with the notes the card holds; a started one
     * is not offered again. The notes stay for the card's next attempt.
     */
    const recover = Effect.fnUntraced(function* (goal: KanbanGoal) {
      yield* Effect.forEach(
        (yield* attempts.pending(goal.goalInstanceId)).filter(
          (attempt) => attempt.outcome === null,
        ),
        Effect.fnUntraced(function* (attempt) {
          const { notes } = yield* attempts.ladder(attempt.goalInstanceId, attempt.cardId);
          yield* start({
            sessionId: attempt.sessionId,
            goalInstanceId: attempt.goalInstanceId,
            cardId: attempt.cardId,
            attemptNo: attempt.attemptNo,
            goalVersion: attempt.goalVersion,
            planVersion: attempt.planVersion,
            notes,
          });
        }),
        { discard: true },
      );
    });

    yield* Effect.forEach(
      yield* attempts.activeGoals,
      (goal) => Effect.andThen(recover(goal), run(goal)),
      { discard: true },
    );

    return {
      /**
       * Runs the session's current Goal as a kanban board. The Plan must be executing. A project
       * that cannot have worktrees runs its cards one at a time in the project itself.
       */
      start: Effect.fn("KanbanOrchestrator.start")(function* (sessionId: string) {
        const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
        const state = yield* workflows.get(sessionId);
        if (goalInstanceId === null || state.goal === null)
          return yield* KanbanStartRefused.make({ reason: "goal_missing" });
        if (state.phase !== "execute" || state.plan?.status !== "executing")
          return yield* KanbanStartRefused.make({ reason: "plan_not_executing" });
        const session = yield* sessions.get(sessionId);
        const project = yield* projects.get(session.projectId);
        const mode = yield* worktrees
          .prepareGoal({ projectRoot: project.root, goalInstanceId })
          .pipe(
            Effect.as("worktree" as const),
            Effect.catchTag("CardWorktreeFailed", (failure) =>
              failure.reason._tag === "SequentialRequired"
                ? Effect.succeed("sequential" as const)
                : Effect.fail(KanbanStartRefused.make({ reason: "worktree_unavailable" })),
            ),
          );
        // The Goal merges into the branch the user had checked out when its board started.
        const targetBranch =
          mode === "worktree"
            ? Option.getOrNull(
                yield* worktrees
                  .currentBranch(project.root)
                  .pipe(
                    Effect.catchTag("CardWorktreeFailed", () =>
                      Effect.succeed(Option.none<string>()),
                    ),
                  ),
              )
            : null;
        yield* schedules.register({ goalInstanceId, projectId: project.id, targetBranch });
        yield* attempts.registerGoal({
          goalInstanceId,
          sessionId,
          projectId: project.id,
          projectRoot: project.root,
          mode,
          goalVersion: state.goal.version,
        });
        yield* run({ sessionId, goalInstanceId });
        return { goalInstanceId, mode };
      }),

      /** Runs a board's loop again after it stopped on exhausted retries or a defect. */
      restart: (board: BoardRef) => Effect.andThen(health.restart(board), run(board)),

      /** Wakes a board's loop now, after a change the loop should see. */
      poke: (goalInstanceId: string) => PubSub.publish(pokes, goalInstanceId),

      /** Why boards need the orchestrator model, as their loops find out. */
      attention: Stream.fromPubSub(attention),

      /** Stops a card's running attempt; its delivery completes as Stopped. */
      stopAttempt: (goalInstanceId: string, cardId: string) => runs.stop(goalInstanceId, cardId),

      /**
       * Puts a blocked card whose attempt was dead-lettered back on the queue: the same item with
       * a fresh delivery budget, continuing in the card's worktree.
       */
      requeue: Effect.fn("KanbanOrchestrator.requeue")(function* (
        sessionId: string,
        cardId: string,
        author: BoardAuthor,
      ) {
        const goalInstanceId = yield* workflows.goalInstanceId(sessionId);
        const dead = (yield* attempts.deadLettered(cardQueueName)).filter(
          (item) => item.goalInstanceId === goalInstanceId && item.cardId === cardId,
        );
        const item = dead.at(-1);
        if (item === undefined) return false;
        yield* attempts.updateLadder(item.goalInstanceId, cardId, (current) => ({
          ...current,
          reason: null,
        }));
        yield* attempts.reopen(item);
        yield* workflows.transitionCard(
          sessionId,
          { cardId, from: "blocked", to: "ready", detail: `card ${cardId} requeued` },
          author,
        );
        yield* workflows.transitionCard(
          sessionId,
          { cardId, from: "ready", to: "in_progress", detail: `card ${cardId} continues` },
          author,
        );
        yield* items.requeue(cardQueueName, item.itemId);
        yield* PubSub.publish(pokes, item.goalInstanceId);
        return true;
      }, looking.withPermits(1)),
    };
  });

/** The kanban Goal orchestrator loops of this owner. */
export class KanbanOrchestrator extends Context.Service<
  KanbanOrchestrator,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/kanban/orchestrator/KanbanOrchestrator") {
  static readonly layer = (options: KanbanOrchestratorOptions = {}) =>
    Layer.effect(KanbanOrchestrator, make(options));
}
