import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Layer, Queue, Ref, Scope } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { KanbanSettings } from "../config/kanban-settings.ts";
import {
  assignCard,
  card,
  executingBoard,
  kanbanFixture,
  kanbanOwner,
  scriptedAgent,
  switchGoalInstance,
  uncertainCardRun,
  type KanbanFixture,
} from "../testing/kanban.ts";
import { CardAgentOutcome, type CardAgentRun } from "./card-agent.ts";
import { CardAttemptOutcome, CardAttempts } from "./card-attempts.ts";

type Owner = Layer.Success<ReturnType<typeof kanbanOwner>>;

/** Opens an owner over the fixture in its own scope; closing that scope is the owner stopping. */
const openOwner = (
  fixture: KanbanFixture,
  agent: (run: CardAgentRun) => Effect.Effect<CardAgentOutcome>,
  scope: Scope.Scope,
) =>
  Effect.map(
    Layer.buildWithScope(kanbanOwner({ fixture, agent: scriptedAgent(agent) }), scope),
    (context) =>
      <A, E>(effect: Effect.Effect<A, E, Owner>) =>
        Effect.provideContext(effect, context),
  );

const finished: CardAgentOutcome = CardAgentOutcome.Finished({ report: "done" });

/** Node services for a test, built in its scope. */
const withNode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(NodeServices.layer), (context) =>
    Effect.provideContext(program, context),
  ).pipe(Effect.scoped);

it.live(
  "runs no more cards at once than the concurrency setting, and a resize applies at once",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const started = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const running = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const run = yield* openOwner(
        fixture,
        (agent) =>
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(running, (count) => count + 1);
            yield* Ref.update(peak, (max) => Math.max(max, now));
            yield* Queue.offer(started, agent.card.id);
            yield* Deferred.await(release);
            yield* Ref.update(running, (count) => count - 1);
            return finished;
          }),
        yield* Effect.scope,
      );
      yield* run(
        Effect.gen(function* () {
          // Two cores: the default is one card at a time.
          const board = yield* executingBoard(fixture, [card("a"), card("b")]);
          const a = yield* assignCard(board, "a");
          const b = yield* assignCard(board, "b");
          const first = yield* Queue.take(started);
          expect(yield* Ref.get(peak)).toBe(1);

          // Saving the setting resizes the gate; nobody calls reconfigure. The second card takes
          // the new permit while the first still holds its own.
          yield* (yield* KanbanSettings).setConcurrency(2);
          const second = yield* Queue.take(started);
          expect([first, second].toSorted()).toEqual(["a", "b"]);
          expect(yield* Ref.get(peak)).toBe(2);

          yield* Deferred.succeed(release, undefined);
          const attempts = yield* CardAttempts;
          expect(CardAttemptOutcome.guards.Completed(yield* attempts.awaitOutcome(a))).toBe(true);
          expect(CardAttemptOutcome.guards.Completed(yield* attempts.awaitOutcome(b))).toBe(true);
        }),
      );
    }).pipe(withNode),
);

it.live("does not continue past an earlier run with an uncertain tool", () =>
  Effect.gen(function* () {
    const fixture = yield* kanbanFixture;
    const calls = yield* Ref.make(0);
    const run = yield* openOwner(
      fixture,
      () =>
        Effect.as(
          Ref.update(calls, (count) => count + 1),
          finished,
        ),
      yield* Effect.scope,
    );
    const outcome = yield* run(
      Effect.gen(function* () {
        const board = yield* executingBoard(fixture, [card("a")]);
        yield* uncertainCardRun(board, "a", "run-0");
        return yield* (yield* CardAttempts).awaitOutcome(yield* assignCard(board, "a"));
      }),
    );
    expect(outcome).toEqual(CardAttemptOutcome.cases.Fenced.make({ runId: "run-0" }));
    expect(yield* Ref.get(calls)).toBe(0);
  }).pipe(withNode),
);

it.live("completes an earlier Goal instance's card as Superseded without running it", () =>
  Effect.gen(function* () {
    const fixture = yield* kanbanFixture;
    const ran = yield* Ref.make<ReadonlyArray<string>>([]);
    const holding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const run = yield* openOwner(
      fixture,
      (agent) =>
        Effect.gen(function* () {
          yield* Ref.update(ran, (ids) => [...ids, agent.card.id]);
          if (agent.card.id === "a") {
            yield* Deferred.succeed(holding, undefined);
            yield* Deferred.await(release);
          }
          return finished;
        }),
      yield* Effect.scope,
    );
    const outcome = yield* run(
      Effect.gen(function* () {
        const board = yield* executingBoard(fixture, [card("a"), card("b")]);
        yield* assignCard(board, "a");
        // The only permit is held by card a, so b waits in the queue while the Goal changes.
        yield* Deferred.await(holding);
        const b = yield* assignCard(board, "b");
        yield* switchGoalInstance(board.sessionId);
        yield* Deferred.succeed(release, undefined);
        return yield* (yield* CardAttempts).awaitOutcome(b);
      }),
    );
    expect(outcome).toEqual(CardAttemptOutcome.cases.Superseded.make({}));
    expect(yield* Ref.get(ran)).toEqual(["a"]);
  }).pipe(withNode),
);
