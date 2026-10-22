import {
  Context,
  Data,
  Effect,
  Function as EffectFunction,
  Layer,
  Option,
  Predicate,
  PubSub,
  Ref,
  Stream,
} from "effect";
import { KanbanSettings } from "../config/kanban-settings.ts";
import { Workflows, type PlanStep, type WorkflowStorageError } from "../workflow/workflow.ts";
import { CardAttempts, type KanbanGoal, type KanbanStorageFailed } from "./card-attempts.ts";
import { CardOrder } from "./card-order.ts";
import {
  GoalSchedules,
  type GoalScheduleStorageFailed,
  mergeReleases,
  type GoalPriority,
} from "./goal-schedules.ts";
import { HumanDecisions } from "./human-decision.ts";

/**
 * The project scheduler (docs/kanban-orchestration.md "프로젝트 스케줄러"): a deterministic
 * service, not a model, that decides which cards take the card slots. It starts cards in the
 * project's one order of cards (`CardOrder`), which a person arranges across Goals, keeps Goals
 * that wait for another Goal's merge off the slots, and tells boards when their cards' expected
 * files overlap another Goal's cards.
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

/** A card a Goal could start now, with its place in its project's order. */
interface Candidate {
  readonly goal: KanbanGoal;
  readonly cardId: string;
  /** A card left in progress continues before anything starts. */
  readonly rank: number;
}

/**
 * Hands `free` slots to candidates in order: within a project the person's order, between
 * projects turn by turn. A Goal takes no more than its mode allows.
 */
const assign = (
  lanes: ReadonlyArray<readonly Candidate[]>,
  held: ReadonlyMap<string, number>,
  free: number,
  limit: number,
) => {
  const given = new Map(held);
  const assigned = new Map<string, string[]>();
  let left = free;
  const longest = Math.max(0, ...lanes.map((lane) => lane.length));
  for (let turn = 0; turn < longest && left > 0; turn++)
    for (const lane of lanes) {
      const candidate = lane[turn];
      if (candidate === undefined || left <= 0) continue;
      const id = candidate.goal.goalInstanceId;
      const cap = candidate.goal.mode === "sequential" ? 1 : limit;
      const mine = given.get(id) ?? 0;
      if (mine >= cap) continue;
      given.set(id, mine + 1);
      assigned.set(id, [...(assigned.get(id) ?? []), candidate.cardId]);
      left -= 1;
    }
  return assigned;
};

const make = Effect.gen(function* () {
  const attempts = yield* CardAttempts;
  const schedules = yield* GoalSchedules;
  const settings = yield* KanbanSettings;
  const workflows = yield* Workflows;
  const decisions = yield* HumanDecisions;
  const cardOrder = yield* CardOrder;
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
    const waiting: string[] = [];
    for (const other of edges.get(goalInstanceId) ?? []) {
      const found = yield* schedules.get(other);
      if (Option.isSome(found) && !mergeReleases(found.value.merge)) waiting.push(other);
    }
    return waiting;
  });

  /** Wakes every board of the project, after something they wait on may have changed. */
  const pokeProject = Effect.fnUntraced(function* (projectId: string) {
    const goals = (yield* attempts.activeGoals).filter((goal) => goal.projectId === projectId);
    yield* Effect.forEach(goals, (goal) => poke(goal.goalInstanceId), { discard: true });
  });

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
     * project's order, so a Goal whose cards come later waits. Goals that got cards are woken to
     * start them.
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
      const projects = [...new Set(active.map((other) => other.projectId))];
      const orders = new Map(
        yield* Effect.forEach(projects, (projectId) =>
          Effect.map(
            cardOrder.order(projectId),
            (order) =>
              [
                projectId,
                new Map(order.map((ref, index) => [`${ref.sessionId}:${ref.cardId}`, index])),
              ] as const,
          ),
        ),
      );
      const lanes = new Map(projects.map((projectId): [string, Candidate[]] => [projectId, []]));
      for (const other of active) {
        // A Goal waiting for another Goal's merge takes no slots.
        if ((yield* waitingOn(other.goalInstanceId)).length > 0) continue;
        const wanted =
          other.goalInstanceId === goal.goalInstanceId
            ? planned
            : yield* startable(other, known.get(other.goalInstanceId));
        const order = orders.get(other.projectId);
        for (const step of wanted)
          lanes.get(other.projectId)?.push({
            goal: other,
            cardId: step.id,
            rank:
              step.status === "in_progress"
                ? Number.NEGATIVE_INFINITY
                : (order?.get(`${other.sessionId}:${step.id}`) ?? Number.POSITIVE_INFINITY),
          });
      }
      const sorted = projects.map((projectId) =>
        (lanes.get(projectId) ?? []).toSorted((a, b) => a.rank - b.rank),
      );
      const total = [...held.values()].reduce((sum, count) => sum + count, 0);
      const assigned = assign(sorted, held, limit - total, limit);
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
      for (const other of others) {
        const schedule = yield* schedules.get(other.goalInstanceId);
        if (Option.exists(schedule, (found) => mergeReleases(found.merge))) continue;
        if ((yield* workflows.goalInstanceId(other.sessionId)) !== other.goalInstanceId) continue;
        const steps = (yield* workflows.get(other.sessionId)).plan?.steps ?? [];
        for (const step of steps) {
          const files = overlappingBoundaries(card, step);
          if (files.length === 0) continue;
          const otherCard = {
            otherGoalInstanceId: other.goalInstanceId,
            otherCardId: step.id,
          };
          switch (step.status) {
            case "in_progress":
            case "verify":
              return CrossGoalOverlap.Running(otherCard);
            case "done": {
              const chosen = (yield* decisions.forCard(
                goal.sessionId,
                goal.goalInstanceId,
                card.id,
              )).flatMap((request) =>
                Predicate.isTagged(request.kind, "FileOverlap") &&
                request.kind.otherGoalInstanceId === other.goalInstanceId &&
                Predicate.isTagged(request.state, "Answered") &&
                Predicate.isTagged(request.state.answer, "FileOverlap")
                  ? [request.state.answer.choice]
                  : [],
              )[0];
              switch (chosen) {
                case "proceed":
                  continue;
                case "wait":
                  return CrossGoalOverlap.Waiting(otherCard);
                case undefined:
                  return CrossGoalOverlap.Unmerged({ ...otherCard, files });
              }
              break;
            }
            default:
              continue;
          }
        }
      }
      return CrossGoalOverlap.None();
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
      if (known.has(key)) return;
      yield* Ref.set(
        notices,
        new Map(known).set(key, [goalInstanceId, other.otherGoalInstanceId] as const),
      );
      yield* poke(other.otherGoalInstanceId);
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

    /** Sets a Goal's priority and lets every board of its project look again. */
    setPriority: Effect.fn("ProjectScheduler.setPriority")(function* (
      goalInstanceId: string,
      priority: GoalPriority,
    ) {
      yield* schedules.setPriority(goalInstanceId, priority);
      const schedule = yield* schedules.get(goalInstanceId);
      if (Option.isSome(schedule)) yield* pokeProject(schedule.value.projectId);
    }),

    /** Sets the Goals a Goal waits for; a cycle or a Goal of another project is refused. */
    setDependencies: Effect.fn("ProjectScheduler.setDependencies")(function* (
      goalInstanceId: string,
      dependsOn: readonly string[],
    ) {
      const saved = yield* schedules.setDependencies(goalInstanceId, dependsOn);
      const schedule = yield* schedules.get(goalInstanceId);
      if (Option.isSome(schedule)) yield* pokeProject(schedule.value.projectId);
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
