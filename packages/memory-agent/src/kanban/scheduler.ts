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
import {
  GoalSchedules,
  type GoalScheduleStorageFailed,
  mergeReleases,
  priorityWeight,
  type GoalPriority,
  type GoalSchedule,
} from "./goal-schedules.ts";
import { HumanDecisions } from "./human-decision.ts";

/**
 * The project scheduler (docs/kanban-orchestration.md "프로젝트 스케줄러"): a deterministic
 * service, not a model, that decides how Goals share the card slots. It hands slots out round-robin
 * weighted by the user's Goal priority, keeps Goals that wait for another Goal's merge off the
 * slots, and tells boards when their cards' expected files overlap another Goal's cards.
 *
 * Its counters live in memory: after a restart the next looks rebuild them from the boards.
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

interface Contender {
  readonly goalInstanceId: string;
  readonly weight: number;
  /** Slots it could use: what it holds plus what it wants, up to its mode's cap. */
  readonly need: number;
  /** When it was last granted a slot; -1 when never. */
  readonly turn: number;
}

/**
 * Gives `slots` out one at a time to the contender with the fewest slots per weight; ties go to the
 * one granted longest ago. With equal weights this is round-robin.
 */
const allocate = (contenders: readonly Contender[], slots: number) => {
  const given = new Map(contenders.map((contender) => [contender.goalInstanceId, 0]));
  for (let slot = 0; slot < slots; slot++) {
    let best: Contender | undefined;
    for (const contender of contenders) {
      const mine = given.get(contender.goalInstanceId) ?? 0;
      if (mine >= contender.need) continue;
      if (best === undefined) {
        best = contender;
        continue;
      }
      const theirs = given.get(best.goalInstanceId) ?? 0;
      const share = mine / contender.weight - theirs / best.weight;
      if (share < 0 || (share === 0 && contender.turn < best.turn)) best = contender;
    }
    if (best === undefined) break;
    given.set(best.goalInstanceId, (given.get(best.goalInstanceId) ?? 0) + 1);
  }
  return given;
};

const make = Effect.gen(function* () {
  const attempts = yield* CardAttempts;
  const schedules = yield* GoalSchedules;
  const settings = yield* KanbanSettings;
  const workflows = yield* Workflows;
  const decisions = yield* HumanDecisions;
  // What each Goal's last look wanted; a Goal not heard from yet may want every slot.
  const demand = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const turns = yield* Ref.make<{
    readonly next: number;
    readonly last: ReadonlyMap<string, number>;
  }>({ next: 0, last: new Map() });
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

  return {
    /** Goal instances whose boards should look again. */
    wakeups: Stream.fromPubSub(wakeups),

    poke,
    pokeProject,
    waitingOn,

    /**
     * How many of the `wanted` cards the Goal may offer now. Every Goal's look reports what it
     * wants, so a Goal that wants nothing lets the others use its share. Goals that still have a
     * share left are woken to take it.
     */
    grant: Effect.fn("ProjectScheduler.grant")(function* (goal: KanbanGoal, wanted: number) {
      yield* Ref.update(demand, (known) => new Map(known).set(goal.goalInstanceId, wanted));
      const limit = (yield* settings.concurrency).effective;
      const active = yield* attempts.activeGoals;
      const held = yield* attempts.outstanding;
      const known = yield* Ref.get(demand);
      const { last } = yield* Ref.get(turns);
      const scheduled = new Map(
        (yield* schedules.all).map((schedule): [string, GoalSchedule] => [
          schedule.goalInstanceId,
          schedule,
        ]),
      );
      const contenders: Contender[] = [];
      const wants = new Map<string, number>();
      for (const other of active) {
        const id = other.goalInstanceId;
        const holding = held.get(id) ?? 0;
        const waiting = (yield* waitingOn(id)).length > 0;
        const want = waiting ? 0 : id === goal.goalInstanceId ? wanted : (known.get(id) ?? limit);
        wants.set(id, want);
        const cap = other.mode === "sequential" ? 1 : limit;
        const priority: GoalPriority = scheduled.get(id)?.priority ?? "normal";
        contenders.push({
          goalInstanceId: id,
          weight: priorityWeight[priority],
          need: Math.min(cap, holding + want),
          turn: last.get(id) ?? -1,
        });
      }
      const shares = allocate(contenders, limit);
      const total = [...held.values()].reduce((sum, count) => sum + count, 0);
      const mine = (shares.get(goal.goalInstanceId) ?? 0) - (held.get(goal.goalInstanceId) ?? 0);
      const granted = Math.max(
        0,
        Math.min(wants.get(goal.goalInstanceId) ?? 0, mine, limit - total),
      );
      if (granted > 0)
        yield* Ref.update(turns, ({ next, last: previous }) => ({
          next: next + 1,
          last: new Map(previous).set(goal.goalInstanceId, next),
        }));
      // Free slots left over belong to other Goals' shares: wake those Goals to take them.
      if (limit - total - granted > 0)
        yield* Effect.forEach(
          contenders.filter(
            (contender) =>
              contender.goalInstanceId !== goal.goalInstanceId &&
              (wants.get(contender.goalInstanceId) ?? 0) > 0 &&
              (shares.get(contender.goalInstanceId) ?? 0) >
                (held.get(contender.goalInstanceId) ?? 0),
          ),
          (contender) => poke(contender.goalInstanceId),
          { discard: true },
        );
      return granted;
    }),

    /** Forgets what a stopped Goal wanted, so its share goes to the others. */
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
