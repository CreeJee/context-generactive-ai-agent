import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Match,
  Option,
  Predicate,
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
import { BoardAuthor, type CardStatus } from "../workflow/card.ts";
import { Workflows, type PlanStep, type WorkflowState } from "../workflow/workflow.ts";
import { CardVerifier } from "./card-agent.ts";
import {
  AssignmentHold,
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
import {
  cardWorkspace,
  CardWorktrees,
  WorktreeDisposition,
  type CardRef,
  type CardWorktree,
} from "./worktree.ts";
import {
  DecisionCloseScope,
  DecisionKind,
  HumanDecisions,
  type DecisionAnswer,
  type HumanDecisionRequest,
} from "./human-decision.ts";
import { GoalSchedules } from "./goal-schedules.ts";
import { CardFailure, CardHoldReason, failureCode, worktreeFailure } from "./failures.ts";
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

export class KanbanStartRefused extends Schema.TaggedError<
  KanbanStartRefused,
  { readonly brand: unique symbol }
>()("KanbanStartRefused", {
  reason: Schema.Literals(["goal_missing", "plan_not_executing", "worktree_unavailable"]),
}) {}

/** How a repeated failure of a card is answered, by its place on the ladder. */
export type FailureStep = Data.TaggedEnum<{
  Retry: {};
  Backoff: { readonly delay: Duration.Duration };
  Replan: {};
  HumanDecision: {};
}>;
export const FailureStep = Data.taggedEnum<FailureStep>();

/**
 * Retry, then a longer backoff, then a request to replan the card, then a person. The streak
 * counts consecutive failures; a replanned card starts a new streak and goes to a person next time.
 */
const failureStep = (ladder: CardLadder, backoff: Duration.Duration): FailureStep =>
  ladder.failureStreak <= 1
    ? FailureStep.Retry()
    : ladder.failureStreak === 2
      ? FailureStep.Backoff({ delay: backoff })
      : ladder.replans === 0
        ? FailureStep.Replan()
        : FailureStep.HumanDecision();

/** Two cards' expected files overlap when one boundary is the other or lies below it. */
const boundariesOverlap = (left: PlanStep, right: PlanStep) =>
  overlappingBoundaries(left, right).length > 0;

export interface KanbanOrchestratorOptions {
  /** Longest wait between looks at a board when nothing in this process woke it. */
  readonly pollInterval?: Duration.Input;
  /** The wait before a card's second retry. */
  readonly backoff?: Duration.Input;
}

const loopAuthor = (goalInstanceId: string): BoardAuthor =>
  BoardAuthor.cases.Orchestrator.make({ runId: `kanban:${goalInstanceId}` });

/** A squash attempt or Goal sync, read as what the loop does next. */
type Integration = Data.TaggedEnum<{
  Integrated: { readonly commit: string | null };
  GoalAdvanced: {};
  Synced: {};
  Conflict: { readonly files: readonly string[] };
  Failed: { readonly failure: CardFailure };
}>;
const Integration = Data.taggedEnum<Integration>();

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
    const workspace = (goal: KanbanGoal) => cardWorkspace(worktrees, goal.mode);
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
          Effect.catchTag("BoardEditRefused", (refused: BoardEditRefused) =>
            Match.value(refused.reason).pipe(
              Match.whenOr("card_status_changed", "card_missing", () => Effect.succeed(false)),
              Match.orElse(() => Effect.fail(refused)),
            ),
          ),
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
      yield* Effect.when(
        decisions
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
              HumanDecisionRefused: (refused) =>
                Match.value(refused.reason).pipe(
                  Match.whenOr("goal_superseded", "card_missing", () => Effect.void),
                  Match.orElse(() => Effect.fail(refused)),
                ),
              BoardEditRefused: (refused) =>
                Match.value(refused.reason).pipe(
                  Match.whenOr("card_status_changed", "card_missing", () => Effect.void),
                  Match.orElse(() => Effect.fail(refused)),
                ),
            }),
          ),
        Effect.map(workflows.get(goal.sessionId), (state) =>
          Option.exists(
            stepOf(state, cardId),
            (step) => step.status === from || step.status === "human_decision",
          ),
        ),
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
      yield* Match.valueTags(step, {
        Retry: () => move(goal, cardId, from, "ready", `card ${cardId} failed (${code}); retrying`),
        Backoff: ({ delay }) =>
          Effect.andThen(
            attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
              ...current,
              notBefore: now + Duration.toMillis(delay),
              reason: CardHoldReason.cases.RetryBackoff.make({ failure }),
            })),
            move(goal, cardId, from, "ready", `card ${cardId} failed again (${code}); waiting`),
          ),
        Replan: () =>
          Effect.andThen(
            attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
              ...current,
              reason: CardHoldReason.cases.ReplanRequested.make({ failure }),
            })),
            move(goal, cardId, from, "blocked", `card ${cardId} keeps failing (${code}); replan`),
          ),
        HumanDecision: () =>
          Effect.gen(function* () {
            yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
              ...current,
              reason: CardHoldReason.cases.RepeatedFailure.make({ failure }),
            }));
            const attemptNo = yield* latestAttempt(goal, cardId);
            yield* askPerson(
              goal,
              cardId,
              from,
              `retry_exhausted:${attemptNo}`,
              DecisionKind.cases.RetryExhausted.make({ attempts: attemptNo }),
            );
          }),
      });
    });

    const squash = (goal: KanbanGoal, card: PlanStep) =>
      workspace(goal)
        .squashIntoGoal(cardRef(goal, card.id), card.title)
        .pipe(
          Effect.map((result) =>
            Match.valueTags(result, {
              Integrated: ({ commit }): Integration => Integration.Integrated({ commit }),
              AlreadyIntegrated: ({ commit }): Integration => Integration.Integrated({ commit }),
              NoChanges: (): Integration => Integration.Integrated({ commit: null }),
            }),
          ),
          Effect.catchReason(
            "CardWorktreeFailed",
            "GoalAdvanced",
            () => Effect.succeed<Integration>(Integration.GoalAdvanced()),
            (_, failure) =>
              Effect.succeed<Integration>(
                Integration.Failed({ failure: worktreeFailure(failure) }),
              ),
          ),
        );
    const sync = (goal: KanbanGoal, card: PlanStep) =>
      workspace(goal)
        .syncWithGoal(cardRef(goal, card.id))
        .pipe(
          Effect.as<Integration>(Integration.Synced()),
          Effect.catchTags({
            CardIntegrationConflict: (conflict) =>
              Effect.succeed<Integration>(Integration.Conflict({ files: conflict.files })),
            CardWorktreeFailed: (failure) =>
              Effect.succeed<Integration>(
                Integration.Failed({ failure: worktreeFailure(failure) }),
              ),
          }),
        );

    /** A resolution card that conflicts again goes to a person. */
    const askAboutConflict = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      card: PlanStep,
      files: readonly string[],
    ) {
      yield* attempts.updateLadder(goal.goalInstanceId, card.id, (current) => ({
        ...current,
        reason: CardHoldReason.cases.MergeConflict.make({ files }),
      }));
      const attemptNo = yield* latestAttempt(goal, card.id);
      // A person who answered sends the card on; a conflict after that is a new occasion.
      const answered = (yield* decisions.forCard(
        goal.sessionId,
        goal.goalInstanceId,
        card.id,
      )).filter(
        (request) =>
          Predicate.isTagged(request.kind, "IntegrationConflict") &&
          Predicate.isTagged(request.state, "Answered"),
      ).length;
      yield* askPerson(
        goal,
        card.id,
        "verify",
        `integration_conflict:${attemptNo}:${answered}`,
        DecisionKind.cases.IntegrationConflict.make({ files }),
      );
    });

    /**
     * A conflicting card is re-applied by a resolution card on the current Goal branch, which takes
     * its place in the Plan.
     */
    const addResolutionCard = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      card: PlanStep,
      files: readonly string[],
    ) {
      const listed = files.join(", ");
      const author = loopAuthor(goal.goalInstanceId);
      const resolution = yield* ops.addCard(
        goal.sessionId,
        {
          // Trimmed so the draft satisfies CardText: a stored title may carry edge whitespace.
          title: `Resolve conflicts: ${card.title.trim()}`,
          description: `Card ${card.id} could not join the Goal branch because ${listed} changed there too. Re-apply its change on the current Goal branch. ${workspace(goal).earlierWork(cardRef(goal, card.id))} Do not commit; the owner commits your work.\n\n${card.description}`,
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
      yield* workspace(goal).settle(cardRef(goal, card.id), WorktreeDisposition.Cancelled());
    });

    const resolveConflict = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      card: PlanStep,
      files: readonly string[],
    ) {
      const ladder = yield* attempts.ladder(goal.goalInstanceId, card.id);
      return yield* ladder.resolutionOf === null
        ? addResolutionCard(goal, card, files)
        : askAboutConflict(goal, card, files);
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
      /** Puts a verified card on the Goal branch. True once the card is settled; false asks for another round. */
      const integrate = Effect.fnUntraced(function* (card: PlanStep, evidence: readonly string[]) {
        const squashed = yield* squash(goal, card);
        const integration = Predicate.isTagged(squashed, "GoalAdvanced")
          ? yield* sync(goal, card)
          : squashed;
        return yield* Match.valueTags(integration, {
          Integrated: ({ commit }) =>
            Effect.gen(function* () {
              yield* Effect.when(
                workspace(goal).settle(cardRef(goal, cardId), WorktreeDisposition.Done()),
                move(
                  goal,
                  cardId,
                  "verify",
                  "done",
                  `card ${cardId} integrated${commit === null ? " (no changes)" : ` as ${commit}`}; evidence: ${evidence.join("; ")}`,
                ),
              );
              yield* attempts.updateLadder(goal.goalInstanceId, cardId, (current) => ({
                ...current,
                failureStreak: 0,
                reason: null,
              }));
              return true;
            }),
          Synced: () => Effect.succeed(false),
          GoalAdvanced: () => Effect.succeed(false),
          Conflict: ({ files }) => Effect.as(resolveConflict(goal, card, files), true),
          Failed: ({ failure }) => Effect.as(failCard(goal, cardId, "verify", failure), true),
        });
      });
      /** Verifies the card in its worktree once. True once the card is settled; false asks for another round. */
      const verifyIn = Effect.fnUntraced(function* (card: PlanStep, worktree: CardWorktree) {
        const verdict = yield* verifier.verify({
          sessionId: goal.sessionId,
          projectId: goal.projectId,
          goalInstanceId: goal.goalInstanceId,
          card,
          worktree,
          report,
        });
        // A card amended or held while it was verified: the verdict is about work that no longer
        // counts, so nothing joins the Goal branch on it.
        if ((yield* verifying) === undefined) return true;
        return yield* Match.valueTags(verdict, {
          Failed: ({ failure }) =>
            Effect.as(
              failCard(
                goal,
                cardId,
                "verify",
                CardFailure.cases.Verification.make({ verdict: failure }),
              ),
              true,
            ),
          Passed: ({ evidence }) => integrate(card, evidence),
        });
      });
      /** One round; true once the card is settled or no longer waits for verification. */
      const round = Effect.flatMap(verifying, (card) =>
        card === undefined
          ? Effect.succeed(true)
          : // A card whose worktree is gone is not verified anywhere else; it fails, and its next
            // attempt leases the worktree again.
            workspace(goal)
              .present(cardRef(goal, cardId))
              .pipe(
                Effect.matchEffect({
                  onFailure: (failure) =>
                    Effect.as(failCard(goal, cardId, "verify", worktreeFailure(failure)), true),
                  onSuccess: (worktree) => verifyIn(card, worktree),
                }),
              ),
      );
      // Each round verifies the card as it now is; a sync with a moved Goal branch needs another.
      const settled = yield* round.pipe(Effect.repeat({ until: (settled) => settled, times: 2 }));
      yield* Effect.when(
        failCard(goal, cardId, "verify", CardFailure.cases.GoalBranchKeptMoving.make({})),
        Effect.succeed(!settled),
      );
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
      return yield* Match.valueTags(outcome, {
        Superseded: () => Effect.succeed(true),
        // Whoever stopped the attempt already moved the card. A card taken off the board keeps
        // its work on the card branch.
        Stopped: () =>
          Effect.as(
            Option.isNone(card)
              ? workspace(goal).settle(
                  cardRef(goal, attempt.cardId),
                  WorktreeDisposition.Cancelled(),
                )
              : Effect.void,
            true,
          ),
        Fenced: ({ runId }) =>
          Effect.as(
            Effect.andThen(
              attempts.updateLadder(goal.goalInstanceId, attempt.cardId, (current) => ({
                ...current,
                reason: CardHoldReason.cases.UncertainEffect.make({ runId }),
              })),
              askPerson(
                goal,
                attempt.cardId,
                "in_progress",
                `uncertain_side_effect:${runId}:${attempt.attemptNo}`,
                DecisionKind.cases.UncertainSideEffect.make({ runId, toolNames: [] }),
              ),
            ),
            true,
          ),
        Failed: ({ failure }) =>
          Effect.as(failCard(goal, attempt.cardId, "in_progress", failure), true),
        // Work done against an earlier Goal waits until the cards are classified against it.
        Completed: ({ report }) =>
          goal.hold !== null
            ? Effect.succeed(false)
            : Effect.as(
                Effect.when(
                  startIntegration(goal, attempt.cardId, report),
                  move(
                    goal,
                    attempt.cardId,
                    "in_progress",
                    "verify",
                    `card ${attempt.cardId} finished`,
                  ),
                ),
                true,
              ),
      });
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
      // Only the person's answer clears a fence; the run's effects stay unknown to the loop.
      const acknowledge = (note: string) =>
        DecisionKind.matchOrElse(
          request.kind,
          {
            UncertainSideEffect: ({ runId }) =>
              Effect.andThen(attempts.acknowledgeRun(runId), resume(note)),
          },
          () => resume(note),
        );
      return Match.valueTags(answer, {
        RetryExhausted: ({ choice }) =>
          Match.value(choice).pipe(
            Match.when("requeue", () =>
              attempts.updateLadder(goal.goalInstanceId, request.cardId, (current) => ({
                ...current,
                failureStreak: 0,
                notBefore: null,
                reason: null,
              })),
            ),
            Match.when("stop", () => Effect.void),
            Match.exhaustive,
          ),
        UncertainSideEffect: ({ choice }) =>
          Match.value(choice).pipe(
            Match.when("continue", () =>
              acknowledge(
                "A person checked the earlier run whose effects were unknown and found its work in place. Continue from the worktree as it is.",
              ),
            ),
            Match.when("retry", () =>
              acknowledge(
                "A person checked the earlier run whose effects were unknown and found its work missing. Check the worktree and do that work again.",
              ),
            ),
            Match.when("stop", () => Effect.void),
            Match.exhaustive,
          ),
        IntegrationConflict: ({ choice }) =>
          Match.value(choice).pipe(
            // The card is in verify again; the loop verifies and integrates it.
            Match.when("resolved", () => resume(null)),
            Match.when("rework", () =>
              resume(
                "A person asked to rework this card because it conflicted with the Goal branch. Re-apply its change on the current Goal branch.",
              ),
            ),
            Match.when("stop", () => Effect.void),
            Match.exhaustive,
          ),
        ImpactUnclear: ({ choice }) =>
          Match.value(choice).pipe(
            Match.when("continue", () => resume(null)),
            // The orchestrator model replaces the card, as for any replan request.
            Match.when("replace", () =>
              attempts.updateLadder(goal.goalInstanceId, request.cardId, (current) => ({
                ...current,
                reason: CardHoldReason.cases.ReplanRequested.make({ failure: null }),
              })),
            ),
            Match.when("stop", () => Effect.void),
            Match.exhaustive,
          ),
        // The answer moved the card back to ready; the assignment reads the choice from the request.
        FileOverlap: () => resume(null),
        // Goal-level answers are the merge queue's to follow.
        ProtectedBranchMerge: () => Effect.void,
        MergeConflict: () => Effect.void,
      });
    };

    /** Follows each answered request of the board once, before cards are assigned. */
    const followAnswers = Effect.fnUntraced(function* (goal: KanbanGoal) {
      const followed = yield* attempts.followedDecisions(goal.goalInstanceId);
      const answered = (yield* decisions.forGoal(goal.sessionId, goal.goalInstanceId)).flatMap(
        (request) =>
          Match.valueTags(request.state, {
            Answered: ({ answer }) =>
              followed.has(request.requestId) ? [] : [{ request, answer }],
            Pending: () => [],
            Closed: () => [],
          }),
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
        (item) =>
          Effect.when(
            attempts
              .updateLadder(goal.goalInstanceId, item.cardId, (current) => ({
                ...current,
                reason: CardHoldReason.cases.DeadLettered.make({}),
              }))
              .pipe(
                Effect.andThen(
                  move(
                    goal,
                    item.cardId,
                    "in_progress",
                    "blocked",
                    `card ${item.cardId} ran out of deliveries; requeue it from the board`,
                  ),
                ),
                Effect.andThen(attempts.markHandled(item)),
              ),
            Effect.map(
              attempts.attempt(item),
              Option.exists((attempt) => !attempt.handled),
            ),
          ),
        { discard: true },
      );
    });

    /**
     * Stops a board: its running cards and integrations stop, the board is stopped so its loop
     * ends at the next look, and its people's waits close with the cards.
     */
    const halt = Effect.fnUntraced(function* (goal: KanbanGoal, steps: readonly PlanStep[]) {
      const { goalInstanceId } = goal;
      yield* Effect.forEach(
        steps,
        (step) =>
          Effect.andThen(
            runs.stop(goalInstanceId, step.id),
            FiberMap.remove(integrations, `${goalInstanceId}:${step.id}`),
          ),
        { discard: true },
      );
      yield* attempts.stopGoal(goalInstanceId);
      yield* decisions.close(
        DecisionCloseScope.Goal({ sessionId: goal.sessionId, goalInstanceId }),
        "card_stopped",
      );
      yield* scheduler.forget(goalInstanceId);
      yield* scheduler.clearNotices(goalInstanceId);
    });

    /** A Goal changed since its cards were classified holds assignment until they are again. */
    const holdAssignment = (goal: KanbanGoal, goalVersion: number) => {
      const hold = AssignmentHold.make({ fromVersion: goal.goalVersion, toVersion: goalVersion });
      return Effect.as(attempts.setHold(goal.goalInstanceId, hold, goal.goalVersion), {
        ...goal,
        hold,
      });
    };

    /** The board's cards that may start now, in the order they start. */
    const assignable = Effect.fnUntraced(function* (
      goal: KanbanGoal,
      steps: readonly PlanStep[],
      ladders: ReadonlyMap<string, CardLadder>,
    ) {
      const busy = new Set(
        (yield* attempts.pending(goal.goalInstanceId)).map((attempt) => attempt.cardId),
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
      return yield* Effect.reduce(
        [...orphans, ...ready],
        (): readonly PlanStep[] => [],
        (planned, step) =>
          // Expected files that overlap a working card wait for it; this is a hint, not a lock.
          [...working, ...planned].some(
            (other) => other.id !== step.id && boundariesOverlap(step, other),
          )
            ? Effect.succeed(planned)
            : Effect.flatMap(scheduler.crossGoalOverlap(goal, step), (overlap) =>
                Match.valueTags(overlap, {
                  None: () => Effect.succeed([...planned, step]),
                  // Another Goal's running card goes first; both boards hear about it.
                  Running: (running) =>
                    Effect.as(scheduler.notice(goal.goalInstanceId, step.id, running), planned),
                  Waiting: () => Effect.succeed(planned),
                  // Another Goal finished these files but has not merged: a person picks the order.
                  Unmerged: ({ otherGoalInstanceId, otherCardId, files }) =>
                    Effect.as(
                      askPerson(
                        goal,
                        step.id,
                        step.status,
                        `file_overlap:${otherGoalInstanceId}`,
                        DecisionKind.cases.FileOverlap.make({
                          otherGoalInstanceId,
                          otherCardId,
                          files,
                        }),
                      ),
                      planned,
                    ),
                }),
              ),
      );
    });

    /** One look at a board: take up outcomes, then assign what may run. */
    const tick = Effect.fnUntraced(function* (goalInstanceId: string) {
      const found = yield* attempts.goal(goalInstanceId);
      if (Option.isNone(found) || !found.value.active) return "stopped" as const;
      const stored = found.value;
      if ((yield* workflows.goalInstanceId(stored.sessionId)) !== goalInstanceId) {
        // A new Goal took over the session; this board's items complete as Superseded and its
        // people's waits close.
        yield* attempts.stopGoal(goalInstanceId);
        yield* decisions.closeSuperseded(stored.sessionId);
        yield* scheduler.forget(goalInstanceId);
        yield* scheduler.clearNotices(goalInstanceId);
        return "stopped" as const;
      }
      const before = yield* workflows.get(stored.sessionId);
      if (before.plan?.status === "closed") {
        // A closed Plan runs no card again: its running cards stop, its board stops and its
        // people's waits close with the cards.
        yield* halt(stored, before.plan.steps);
        return "stopped" as const;
      }
      const goalVersion = before.goal?.version ?? stored.goalVersion;
      const goal: KanbanGoal =
        goalVersion > stored.goalVersion && stored.hold === null
          ? yield* holdAssignment(stored, goalVersion)
          : stored;

      yield* blockDeadLetters(goal);
      const outcomes = (yield* attempts.pending(goalInstanceId)).flatMap((attempt) =>
        attempt.outcome === null ? [] : [{ attempt, outcome: attempt.outcome }],
      );
      yield* Effect.forEach(
        outcomes,
        ({ attempt, outcome }) =>
          Effect.when(attempts.markHandled(attempt), takeUp(goal, before, attempt, outcome)),
        { discard: true },
      );

      const state = yield* workflows.get(goal.sessionId);
      // After reading the board: an answer is stored before it moves its card, so every card an
      // answer moved in this board is followed before it can be assigned.
      yield* followAnswers(goal);
      const steps = state.plan?.steps ?? [];
      const ladders = new Map(
        yield* Effect.forEach(steps, (step) =>
          Effect.map(
            attempts.ladder(goalInstanceId, step.id),
            (ladder) => [step.id, ladder] as const,
          ),
        ),
      );
      const replanning = steps
        .filter(
          (step) =>
            step.status === "blocked" &&
            Predicate.isTagged(ladders.get(step.id)?.reason, "ReplanRequested"),
        )
        .map((step) => step.id);
      const requests = yield* attempts.pendingChangeRequests(goal.sessionId);
      const allDone = steps.length > 0 && steps.every((step) => step.status === "done");

      // Cards in verify that no integration is working on (after a restart, or a person moved
      // them there) are verified again.
      yield* Effect.forEach(
        steps.filter((step) => step.status === "verify"),
        (step) =>
          Effect.when(
            startIntegration(goal, step.id, ""),
            Effect.map(
              FiberMap.has(integrations, `${goalInstanceId}:${step.id}`),
              (integrating) => !integrating,
            ),
          ),
        { discard: true },
      );

      const executing = state.phase === "execute" && state.plan?.status === "executing";
      // A Goal waiting for another Goal's merge takes no slots; its cards stay where they are.
      const waitingOn = yield* scheduler.waitingOn(goalInstanceId);
      yield* scheduler.clearNotices(goalInstanceId);
      const planned =
        executing && goal.hold === null && waitingOn.length === 0
          ? yield* assignable(goal, steps, ladders)
          : [];
      // Every look reports the cards it could start; the scheduler picks the project's next ones.
      const granted = yield* scheduler.grant(goal, planned);
      yield* Effect.forEach(
        granted,
        (step) =>
          Effect.when(
            offer(goal, state, step),
            step.status === "in_progress"
              ? Effect.succeed(true)
              : move(goal, step.id, "ready", "in_progress", `card ${step.id} assigned`),
          ),
        { discard: true },
      );

      // Every card is done: the merge queue takes the Goal into its target branch.
      const schedule = yield* schedules.get(goalInstanceId);
      if (executing && goal.hold === null && allDone) yield* merges.offer(goal);
      yield* Effect.when(
        merges.takeUpstream(goal),
        Effect.succeed(Option.exists(schedule, (found) => found.upstreamPending)),
      );
      const notices = yield* scheduler.notices(goalInstanceId);
      const raised = {
        goal_changed: goal.hold !== null,
        replan_requested: replanning.length > 0,
        change_requested: requests > 0,
        cards_done: allDone,
        file_overlap: notices.length > 0,
        goal_unverified: Option.exists(schedule, (found) =>
          Predicate.isTagged(found.merge, "VerifyFailed"),
        ),
        upstream_regressed: steps.some(
          (step) =>
            step.status === "done" &&
            Predicate.isTagged(ladders.get(step.id)?.reason, "UpstreamRegressed"),
        ),
      } as const satisfies Record<KanbanAttentionReason, boolean>;
      const reasons = KanbanAttentionReason.literals.filter((reason) => raised[reason]);

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
          /** One look, then a wait for the next reason to look; true once the loop stops. */
          const look = Effect.gen(function* () {
            if (loopStopped(yield* health.get(goalInstanceId))) return true;
            const step = yield* looking
              .withPermits(1)(tick(goalInstanceId))
              .pipe(health.supervise(board, "Kanban board look failed", {}));
            const stopped = Match.valueTags(step, {
              Stopped: () => true,
              Continued: ({ value }) => value === "stopped",
            });
            yield* Effect.when(
              PubSub.take(wakeups).pipe(
                Effect.repeat({ until: (woken) => woken === goalInstanceId }),
                Effect.timeoutOption(pollInterval),
              ),
              Effect.succeed(!stopped),
            );
            return stopped;
          });
          yield* look.pipe(Effect.repeat({ until: (stopped) => stopped }));
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
            Effect.catchReason(
              "CardWorktreeFailed",
              "SequentialRequired",
              () => Effect.succeed("sequential" as const),
              () => Effect.fail(KanbanStartRefused.make({ reason: "worktree_unavailable" })),
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
       * Stops the conversation's running boards before it is deleted, as a closed Plan stops them.
       * No look runs meanwhile, so none starts a card after its board stopped.
       */
      stopSession: Effect.fn("KanbanOrchestrator.stopSession")(function* (sessionId: string) {
        const goals = (yield* attempts.activeGoals).filter((goal) => goal.sessionId === sessionId);
        const steps = (yield* workflows.get(sessionId)).plan?.steps ?? [];
        yield* Effect.forEach(goals, (goal) => halt(goal, steps), { discard: true });
      }, looking.withPermits(1)),

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
