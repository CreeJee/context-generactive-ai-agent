import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Layer, Option, Ref, Schedule } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  card,
  executingPlan,
  executingSession,
  kanbanFixture,
  openKanbanOwner,
} from "../testing/kanban.ts";
import { CardAgentOutcome, type CardAgentRun } from "./card-agent.ts";
import { GoalMergeState, GoalScheduleRefused, GoalSchedules } from "./goal-schedules.ts";
import { DecisionAnswer, DecisionKind, HumanDecisions } from "./human-decision.ts";
import { KanbanOrchestrator } from "./orchestrator.ts";
import { ProjectScheduler } from "./scheduler.ts";

const finished: CardAgentOutcome = CardAgentOutcome.Finished({ report: "done" });

const withNode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
    Effect.provideContext(program, context),
  ).pipe(Effect.scoped);

const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("15 seconds"),
  );

/** One gate per card id; a card's agent runs until its gate opens. */
const gates = (ids: readonly string[]) =>
  Effect.map(
    Effect.forEach(ids, () => Deferred.make<void>()),
    (made) => {
      const byId = new Map(ids.map((id, index) => [id, made[index]]));
      return {
        wait: (id: string) => {
          const gate = byId.get(id);
          return gate === undefined ? Effect.void : Deferred.await(gate);
        },
        open: (id: string) => {
          const gate = byId.get(id);
          return gate === undefined ? Effect.void : Deferred.succeed(gate, undefined);
        },
      };
    },
  );

it.live("hands a freed slot to the other Goal and never runs more cards than the limit", () =>
  Effect.gen(function* () {
    const fixture = yield* kanbanFixture;
    const ids = ["a1", "a2", "a3", "b1", "b2", "b3"];
    const gate = yield* gates(ids);
    const started = yield* Ref.make<ReadonlyArray<string>>([]);
    const running = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
      // Four cores: two cards at once.
      cores: 4,
      agent: (agent: CardAgentRun) =>
        Effect.gen(function* () {
          yield* Ref.update(started, (list) => [...list, agent.card.id]);
          const now = yield* Ref.updateAndGet(running, (count) => count + 1);
          yield* Ref.update(peak, (most) => Math.max(most, now));
          yield* gate.wait(agent.card.id);
          yield* Ref.update(running, (count) => count - 1);
          return finished;
        }),
    });
    yield* run(
      Effect.gen(function* () {
        const orchestrator = yield* KanbanOrchestrator;
        const first = yield* executingPlan(fixture, [card("a1"), card("a2"), card("a3")]);
        yield* orchestrator.start(first.sessionId);
        yield* eventually(Ref.get(started), (list) => list.length === 2);
        const second = yield* executingSession(first.projectId, [
          card("b1"),
          card("b2"),
          card("b3"),
        ]);
        yield* orchestrator.start(second.sessionId);
        // Goal A holds both slots; each slot it frees goes to whichever Goal is below its share.
        for (const [release, next] of [
          ["a1", "b1"],
          ["a2", "a3"],
          ["b1", "b2"],
          ["a3", "b3"],
        ] as const) {
          const before = (yield* Ref.get(started)).length;
          yield* gate.open(release);
          const list = yield* eventually(Ref.get(started), (now) => now.length === before + 1);
          expect(list.at(-1)).toBe(next);
        }
        yield* Effect.forEach(ids, gate.open, { discard: true });
      }),
    );
    expect(yield* Ref.get(peak)).toBe(2);
  }).pipe(withNode),
);

it.live("keeps a Goal that waits for another Goal off the slots until that Goal merges", () =>
  Effect.gen(function* () {
    const fixture = yield* kanbanFixture;
    const gate = yield* gates(["a1", "b1"]);
    const seen = yield* Ref.make<ReadonlyMap<string, GoalMergeState | null>>(new Map());
    // Where Goal A's merge stands; set once Goal A exists.
    let mergeOfA: Effect.Effect<GoalMergeState | null> = Effect.succeed(null);
    const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
      cores: 4,
      agent: (agent) =>
        Effect.gen(function* () {
          const merge = yield* mergeOfA;
          yield* Ref.update(seen, (known) => new Map(known).set(agent.card.id, merge));
          yield* gate.wait(agent.card.id);
          return finished;
        }),
    });
    yield* run(
      Effect.gen(function* () {
        const orchestrator = yield* KanbanOrchestrator;
        const schedules = yield* GoalSchedules;
        const scheduler = yield* ProjectScheduler;
        const goalA = yield* executingPlan(fixture, [card("a1")]);
        mergeOfA = schedules
          .get(goalA.goalInstanceId)
          .pipe(
            Effect.map(Option.flatMap((schedule) => Option.fromNullishOr(schedule.merge))),
            Effect.map(Option.getOrNull),
            Effect.orDie,
          );
        yield* schedules.setProtectedBranches(goalA.projectId, []);
        yield* orchestrator.start(goalA.sessionId);
        yield* eventually(Ref.get(seen), (known) => known.has("a1"));

        // B is told to wait for A before its board starts; C waits for A too.
        const goalB = yield* executingSession(goalA.projectId, [card("b1")]);
        const goalC = yield* executingSession(goalA.projectId, [card("c1")]);
        for (const goal of [goalB, goalC]) {
          yield* schedules.register({
            goalInstanceId: goal.goalInstanceId,
            projectId: goal.projectId,
            targetBranch: "main",
          });
          yield* scheduler.setDependencies(goal.goalInstanceId, [goalA.goalInstanceId]);
          yield* orchestrator.start(goal.sessionId);
        }
        const cycle = yield* scheduler
          .setDependencies(goalA.goalInstanceId, [goalC.goalInstanceId])
          .pipe(Effect.flip);
        expect(cycle).toBeInstanceOf(GoalScheduleRefused);
        expect(cycle).toMatchObject({ reason: "dependency_cycle" });

        // A person lifts B's wait: B runs while A has not merged.
        yield* scheduler.setDependencies(goalB.goalInstanceId, []);
        yield* eventually(Ref.get(seen), (known) => known.has("b1"));
        expect((yield* Ref.get(seen)).get("b1")).toBeNull();
        expect((yield* Ref.get(seen)).has("c1")).toBe(false);

        // A merges into main and C continues on its own.
        yield* gate.open("a1");
        yield* eventually(Ref.get(seen), (known) => known.has("c1"));
        expect(GoalMergeState.guards.Merged((yield* Ref.get(seen)).get("c1"))).toBe(true);
        yield* gate.open("b1");
      }),
    );
  }).pipe(withNode),
);

it.live(
  "tells both Goals about overlapping files and asks a person when the other Goal is unmerged",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const gate = yield* gates(["a1"]);
      const started = yield* Ref.make<ReadonlyArray<string>>([]);
      const run = yield* openKanbanOwner(fixture, yield* Effect.scope, {
        cores: 4,
        agent: (agent) =>
          Effect.gen(function* () {
            yield* Ref.update(started, (list) => [...list, agent.card.id]);
            yield* gate.wait(agent.card.id);
            return finished;
          }),
      });
      yield* run(
        Effect.gen(function* () {
          const orchestrator = yield* KanbanOrchestrator;
          const scheduler = yield* ProjectScheduler;
          const decisions = yield* HumanDecisions;
          const goalA = yield* executingPlan(fixture, [card("a1")], { a1: ["src/shared.ts"] });
          yield* orchestrator.start(goalA.sessionId);
          yield* eventually(Ref.get(started), (list) => list.includes("a1"));
          const goalB = yield* executingSession(goalA.projectId, [card("b1")], {
            b1: ["src/shared.ts"],
          });
          yield* orchestrator.start(goalB.sessionId);

          // A's card runs: B's card waits, and both boards hold the notice.
          const notice = `${goalB.goalInstanceId}/b1~${goalA.goalInstanceId}/a1`;
          yield* eventually(scheduler.notices(goalA.goalInstanceId), (keys) =>
            keys.includes(notice),
          );
          expect(yield* scheduler.notices(goalB.goalInstanceId)).toEqual([notice]);
          expect(yield* Ref.get(started)).toEqual(["a1"]);

          // A's card is done but main is protected, so A stays unmerged: a person picks the order.
          yield* gate.open("a1");
          const [request] = yield* eventually(decisions.pending(goalB.sessionId), (pending) =>
            pending.some((item) => DecisionKind.guards.FileOverlap(item.kind)),
          );
          expect(request?.kind).toEqual(
            DecisionKind.cases.FileOverlap.make({
              otherGoalInstanceId: goalA.goalInstanceId,
              otherCardId: "a1",
              files: ["src/shared.ts"],
            }),
          );
          if (request === undefined) return;
          yield* decisions.answer({
            ...request,
            answer: DecisionAnswer.cases.FileOverlap.make({ choice: "proceed" }),
          });
          yield* orchestrator.poke(goalB.goalInstanceId);
          yield* eventually(Ref.get(started), (list) => list.includes("b1"));
        }),
      );
    }).pipe(withNode),
);
