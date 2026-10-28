import {
  Array as EffectArray,
  Context,
  Data,
  Effect,
  Function as EffectFunction,
  Layer,
  Match,
  Option,
  Predicate,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { KanbanSettings } from "../config/kanban-settings.ts";
import { Workflows, type PlanStep, type WorkflowStorageError } from "../workflow/workflow.ts";
import { CardAttempts, type KanbanGoal, type KanbanStorageFailed } from "./card-attempts.ts";
import { GoalOrder } from "./goal-order.ts";
import { GoalSchedules, type GoalScheduleStorageFailed, mergeReleases } from "./goal-schedules.ts";
import { HumanDecisions } from "./human-decision.ts";

/**
 * The project scheduler (docs/kanban-orchestration.md "프로젝트 스케줄러"): a deterministic
 * service, not a model, that decides which cards take the card slots. It walks the priority tree
 * (`GoalOrder`: projects, then each project's Goals, then each Plan's cards) and starts the first
 * cards that can start, keeps Goals that wait for another Goal's merge off the slots, and tells
 * boards when their cards' expected files overlap another Goal's cards.
 *
 * What each Goal could start lives in memory: after a restart the next looks report it again.
 */

interface Bounded {
  readonly boundaries?: readonly string[] | undefined;
}

/** Expected files of `left` that are, contain or lie below an expected file of `right`. */
export const overlappingBoundaries: {
  (right: Bounded): (left: Bounded) => string[];
  (left: Bounded, right: Bounded): string[];
} = EffectFunction.dual(2, (left: Bounded, right: Bounded) =>
  (left.boundaries ?? []).filter((a) =>
    (right.boundaries ?? []).some(
      (b) =>
        a === b ||
        a.startsWith(`${b.replace(/\/$/u, "")}/`) ||
        b.startsWith(`${a.replace(/\/$/u, "")}/`),
    ),
  ),
);

/** How a card's expected files meet another Goal's cards. */
export type CrossGoalOverlap = Data.TaggedEnum<{
  None: {};
  /** The other card is running; this card waits until it finishes. */
  Running: {
    readonly otherGoalInstanceId: string;
    readonly otherCardId: string;
  };
  /** The other card is done but its Goal is not merged, and nobody chose an order yet. */
  Unmerged: {
    readonly otherGoalInstanceId: string;
    readonly otherCardId: string;
    readonly files: readonly string[];
  };
  /** A person chose to wait for the other Goal's merge. */
  Waiting: {
    readonly otherGoalInstanceId: string;
    readonly otherCardId: string;
  };
}>;
export const CrossGoalOverlap = Data.taggedEnum<CrossGoalOverlap>();

/** A card a Goal could start now, with its place in the priority tree. */
interface Candidate {
  readonly goal: KanbanGoal;
  readonly cardId: string;
  /** Project place, Goal place in its project, card place in its Plan. */
  readonly key: readonly [number, number, number];
}

const byKey = (a: Candidate, b: Candidate) =>
  a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2];

/** Hands `free` slots to the candidates in order; a Goal takes no more than its mode allows. */
const assign = (
  candidates: readonly Candidate[],
  held: ReadonlyMap<string, number>,
  free: number,
  limit: number,
): ReadonlyMap<string, readonly string[]> => {
  const slots = candidates.reduce<{
    readonly left: number;
    readonly given: ReadonlyMap<string, number>;
    readonly taken: readonly Candidate[];
  }>(
    (slots, candidate) => {
      const id = candidate.goal.goalInstanceId;
      const mine = slots.given.get(id) ?? 0;
      const cap = candidate.goal.mode === "sequential" ? 1 : limit;
      return slots.left <= 0 || mine >= cap
        ? slots
        : {
            left: slots.left - 1,
            given: new Map(slots.given).set(id, mine + 1),
            taken: [...slots.taken, candidate],
          };
    },
    { left: free, given: held, taken: [] },
  );
  return new Map(
    Object.entries(
      EffectArray.groupBy(slots.taken, (candidate) => candidate.goal.goalInstanceId),
    ).map(([id, taken]) => [id, taken.map((candidate) => candidate.cardId)]),
  );
};

const make = Effect.gen(function* () {
  const attempts = yield* CardAttempts;
  const schedules = yield* GoalSchedules;
  const settings = yield* KanbanSettings;
  const workflows = yield* Workflows;
  const decisions = yield* HumanDecisions;
  const goalOrder = yield* GoalOrder;
  // The cards each Goal's last look could start.
  const demand = yield* Ref.make<ReadonlyMap<string, readonly PlanStep[]>>(new Map());
  const notices = yield* Ref.make<ReadonlyMap<string, readonly [string, string]>>(new Map());
  const wakeups = yield* PubSub.unbounded<string>();

  const poke = (goalInstanceId: string) => PubSub.publish(wakeups, goalInstanceId);

  /** Goals this one waits for that have not merged yet. */
  const waitingOn = Effect.fnUntraced(function* (goalInstanceId: string) {
    const schedule = yield* schedules.get(goalInstanceId);
    if (Option.isNone(schedule)) return [];
    const edges = yield* schedules.edges(schedule.value.projectId);
    return yield* Effect.filter(edges.get(goalInstanceId) ?? [], (other) =>
      Effect.map(
        schedules.get(other),
        Option.exists((found) => !mergeReleases(found.merge)),
      ),
    );
  });

  /** Wakes every board of the project, after something they wait on may have changed. */
  const pokeProject = Effect.fnUntraced(function* (projectId: string) {
    const goals = (yield* attempts.activeGoals).filter((goal) => goal.projectId === projectId);
    yield* Effect.forEach(goals, (goal) => poke(goal.goalInstanceId), { discard: true });
  });

  /** Wakes every board, after the order of projects changed. */
  const pokeAll = Effect.flatMap(attempts.activeGoals, (goals) =>
    Effect.forEach(goals, (goal) => poke(goal.goalInstanceId), { discard: true }),
  );

  /**
   * What another Goal could start now: the cards its last look reported, as far as they are still
   * ready and not held (a Goal nobody heard from yet offers all of those).
   */
  const startable = Effect.fnUntraced(function* (
    goal: KanbanGoal,
    reported: readonly PlanStep[] | undefined,
  ) {
    const state = yield* workflows.get(goal.sessionId);
    const ids = reported === undefined ? null : new Set(reported.map((step) => step.id));
    return (state.plan?.steps ?? []).filter(
      (step) =>
        step.status === "ready" && step.hold === undefined && (ids === null || ids.has(step.id)),
    );
  });

  return {
    /** Goal instances whose boards should look again. */
    wakeups: Stream.fromPubSub(wakeups),

    poke,
    pokeProject,
    waitingOn,

    /**
     * Which of the cards the Goal could start (`planned`, in its Plan order) it may start now.
     * Every Goal's look reports its startable cards; the free slots go to the first cards in the
     * priority tree, so a Goal placed lower waits while a higher one can use the slots. Goals that
     * got cards are woken to start them.
     */
    grant: Effect.fn("ProjectScheduler.grant")(function* (
      goal: KanbanGoal,
      planned: readonly PlanStep[],
    ) {
      yield* Ref.update(demand, (known) => new Map(known).set(goal.goalInstanceId, planned));
      const limit = (yield* settings.concurrency).effective;
      const active = yield* attempts.activeGoals;
      const held = yield* attempts.outstanding;
      const known = yield* Ref.get(demand);
      const projectPlace = new Map(
        (yield* goalOrder.projects).map((projectId, index) => [projectId, index] as const),
      );
      const goalPlace = new Map(
        (yield* Effect.forEach(new Set(active.map((other) => other.projectId)), (projectId) =>
          Effect.map(goalOrder.goals(projectId), (order) =>
            order.map((sessionId, index) => [`${projectId}:${sessionId}`, index] as const),
          ),
        )).flat(),
      );
      // A Goal waiting for another Goal's merge takes no slots.
      const ready = yield* Effect.filter(active, (other) =>
        Effect.map(waitingOn(other.goalInstanceId), (waiting) => waiting.length === 0),
      );
      const candidates = (yield* Effect.forEach(ready, (other) =>
        Effect.map(
          other.goalInstanceId === goal.goalInstanceId
            ? Effect.succeed(planned)
            : startable(other, known.get(other.goalInstanceId)),
          (wanted) =>
            wanted.map((step, index): Candidate => ({
              goal: other,
              cardId: step.id,
              key: [
                projectPlace.get(other.projectId) ?? Number.POSITIVE_INFINITY,
                goalPlace.get(`${other.projectId}:${other.sessionId}`) ?? Number.POSITIVE_INFINITY,
                // A card left in progress continues before its Goal starts anything.
                step.status === "in_progress" ? -1 : index,
              ],
            })),
        ),
      )).flat();
      const total = [...held.values()].reduce((sum, count) => sum + count, 0);
      const assigned = assign(candidates.toSorted(byKey), held, limit - total, limit);
      const mine = new Set(assigned.get(goal.goalInstanceId) ?? []);
      // The other Goals' cards are theirs to start: wake those Goals.
      yield* Effect.forEach(
        [...assigned.keys()].filter((id) => id !== goal.goalInstanceId),
        poke,
        { discard: true },
      );
      return planned.filter((step) => mine.has(step.id));
    }),

    /** Forgets what a stopped Goal could start, so its cards take no slots. */
    forget: (goalInstanceId: string) =>
      Ref.update(demand, (known) => {
        const next = new Map(known);
        next.delete(goalInstanceId);
        return next;
      }),

    /**
     * How the card's expected files meet the cards of the project's other unmerged Goals. A card
     * of another Goal that runs comes first; a finished one of an unmerged Goal needs a person,
     * unless a person already chose.
     */
    crossGoalOverlap: Effect.fn("ProjectScheduler.crossGoalOverlap")(function* (
      goal: KanbanGoal,
      card: PlanStep,
    ): Effect.fn.Return<
      CrossGoalOverlap,
      KanbanStorageFailed | GoalScheduleStorageFailed | WorkflowStorageError
    > {
      if ((card.boundaries ?? []).length === 0) return CrossGoalOverlap.None();
      const others = (yield* attempts.activeGoals).filter(
        (other) =>
          other.goalInstanceId !== goal.goalInstanceId && other.projectRoot === goal.projectRoot,
      );
      /** How the card meets one card of another Goal, when it does. */
      const overlapWith = (
        other: KanbanGoal,
        step: PlanStep,
      ): Effect.Effect<Option.Option<CrossGoalOverlap>, KanbanStorageFailed> => {
        const files = overlappingBoundaries(card, step);
        const otherCard = {
          otherGoalInstanceId: other.goalInstanceId,
          otherCardId: step.id,
        };
        return files.length === 0
          ? Effect.succeedNone
          : Match.value(step.status).pipe(
              Match.when(Match.is("in_progress", "verify"), () =>
                Effect.succeedSome(CrossGoalOverlap.Running(otherCard)),
              ),
              Match.when("done", () =>
                Effect.map(
                  decisions.forCard(goal.sessionId, goal.goalInstanceId, card.id),
                  (requests) =>
                    Option.match(
                      EffectArray.findFirst(requests, (request) =>
                        Predicate.isTagged(request.kind, "FileOverlap") &&
                        request.kind.otherGoalInstanceId === other.goalInstanceId &&
                        Predicate.isTagged(request.state, "Answered") &&
                        Predicate.isTagged(request.state.answer, "FileOverlap")
                          ? Option.some(request.state.answer.choice)
                          : Option.none(),
                      ),
                      {
                        onNone: () =>
                          Option.some(CrossGoalOverlap.Unmerged({ ...otherCard, files })),
                        // A person who chose to go ahead is not asked again.
                        onSome: (choice) =>
                          choice === "proceed"
                            ? Option.none()
                            : Option.some(CrossGoalOverlap.Waiting(otherCard)),
                      },
                    ),
                ),
              ),
              Match.orElse(() => Effect.succeedNone),
            );
      };
      /** The cards of a Goal that still counts: unmerged, and still the session's Goal. */
      const cardsOf = (other: KanbanGoal) =>
        Effect.gen(function* () {
          const schedule = yield* schedules.get(other.goalInstanceId);
          if (Option.exists(schedule, (found) => mergeReleases(found.merge))) return [];
          if ((yield* workflows.goalInstanceId(other.sessionId)) !== other.goalInstanceId)
            return [];
          return (yield* workflows.get(other.sessionId)).plan?.steps ?? [];
        });
      // The first card that meets this one decides; the Goals and their cards are read in order.
      const first = yield* Stream.fromIterable(others).pipe(
        Stream.mapEffect((other) =>
          Effect.map(cardsOf(other), (steps) => steps.map((step) => [other, step] as const)),
        ),
        Stream.flattenIterable,
        Stream.mapEffect(([other, step]) => overlapWith(other, step)),
        Stream.filter(Option.isSome),
        Stream.runHead,
      );
      return Option.getOrElse(Option.flatten(first), () => CrossGoalOverlap.None());
    }),

    /**
     * Records that a card of `goal` waits for a running card of another Goal, and wakes the other
     * board so both orchestrators hear about it.
     */
    notice: Effect.fn("ProjectScheduler.notice")(function* (
      goalInstanceId: string,
      cardId: string,
      other: { readonly otherGoalInstanceId: string; readonly otherCardId: string },
    ) {
      const key = `${goalInstanceId}/${cardId}~${other.otherGoalInstanceId}/${other.otherCardId}`;
      const known = yield* Ref.get(notices);
      yield* Effect.when(
        Effect.andThen(
          Ref.set(
            notices,
            new Map(known).set(key, [goalInstanceId, other.otherGoalInstanceId] as const),
          ),
          poke(other.otherGoalInstanceId),
        ),
        Effect.succeed(!known.has(key)),
      );
    }),

    /** Drops the notices of cards of `goal` that waited; its next look records the current ones. */
    clearNotices: (goalInstanceId: string) =>
      Ref.update(
        notices,
        (known) => new Map([...known].filter(([, [waiting]]) => waiting !== goalInstanceId)),
      ),

    /** The file overlap notices a board is part of, as stable keys. */
    notices: (goalInstanceId: string) =>
      Effect.map(Ref.get(notices), (known) =>
        [...known]
          .filter(([, goals]) => goals.includes(goalInstanceId))
          .map(([key]) => key)
          .toSorted(),
      ),

    /** Moves a conversation's Goal in its project's order and lets the project's boards look again. */
    moveGoal: Effect.fn("ProjectScheduler.moveGoal")(function* (
      projectId: string,
      sessionId: string,
      before: string | null,
    ) {
      const order = yield* goalOrder.moveGoal(projectId, sessionId, before);
      yield* pokeProject(projectId);
      return order;
    }),

    /** Moves a project in the order of projects and lets every board look again. */
    moveProject: Effect.fn("ProjectScheduler.moveProject")(function* (
      projectId: string,
      before: string | null,
    ) {
      const order = yield* goalOrder.moveProject(projectId, before);
      yield* pokeAll;
      return order;
    }),

    /** Sets the Goals a Goal waits for; a cycle or a Goal of another project is refused. */
    setDependencies: Effect.fn("ProjectScheduler.setDependencies")(function* (
      goalInstanceId: string,
      dependsOn: readonly string[],
    ) {
      const saved = yield* schedules.setDependencies(goalInstanceId, dependsOn);
      const schedule = yield* schedules.get(goalInstanceId);
      yield* Effect.transposeOption(Option.map(schedule, (found) => pokeProject(found.projectId)));
      return saved;
    }),
  };
});

/** The project scheduler of this owner's kanban boards. */
export class ProjectScheduler extends Context.Service<
  ProjectScheduler,
  Effect.Success<typeof make>
>()("memory-agent/kanban/scheduler/ProjectScheduler") {
  static readonly layer = Layer.effect(ProjectScheduler, make);
}
