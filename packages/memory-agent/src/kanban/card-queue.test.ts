import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Exit, FileSystem, Layer, Path, Queue, Ref, Scope } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { KanbanSettings } from "../config/kanban-settings.ts";
import {
  assignCard,
  card,
  chatRun,
  executingBoard,
  kanbanFixture,
  kanbanOwner,
  scriptedAgent,
  switchGoalInstance,
  uncertainCardRun,
  type KanbanFixture,
} from "../testing/kanban.ts";
import type { CardAgentOutcome, CardAgentRun } from "./card-agent.ts";
import { CardAttempts } from "./card-attempts.ts";

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

const finished: CardAgentOutcome = { _tag: "Finished", report: "done" };

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
          expect((yield* attempts.awaitOutcome(a))._tag).toBe("Completed");
          expect((yield* attempts.awaitOutcome(b))._tag).toBe("Completed");
        }),
      );
    }).pipe(withNode),
);

it.live(
  "continues a card redelivered after a crash before its result was recorded, without writing again",
  () =>
    Effect.gen(function* () {
      const fixture = yield* kanbanFixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const writes = yield* Ref.make(0);
      const continued = yield* Deferred.make<boolean>();
      const wrote = yield* Deferred.make<void>();
      /** Writes its file only when it is not there yet, like an agent reading the worktree first. */
      const writeOnce = (agent: CardAgentRun) =>
        Effect.gen(function* () {
          const file = path.join(agent.worktree?.toolRoot ?? "", "card.txt");
          if (!(yield* fs.exists(file))) {
            yield* fs.writeFileString(file, "work\n");
            yield* Ref.update(writes, (count) => count + 1);
          }
        }).pipe(Effect.orDie);

      // The first owner's agent writes, then the owner dies before the result is recorded.
      const crashed = yield* Scope.make();
      const first = yield* openOwner(
        fixture,
        (agent) =>
          Effect.gen(function* () {
            yield* agent.register({ runId: "run-1", traceAttemptId: null }).pipe(Effect.orDie);
            yield* writeOnce(agent);
            yield* Deferred.succeed(wrote, undefined);
            return yield* Effect.never;
          }),
        crashed,
      );
      const { board, payload } = yield* first(
        Effect.gen(function* () {
          const board = yield* executingBoard(fixture, [card("a")]);
          const payload = yield* assignCard(board, "a");
          yield* Deferred.await(wrote);
          // The agent's chat run is still running when the owner dies.
          yield* chatRun("run-1", "running");
          return { board, payload };
        }),
      );

      const second = yield* openOwner(
        fixture,
        (agent) =>
          Effect.gen(function* () {
            yield* agent.register({ runId: "run-2", traceAttemptId: null }).pipe(Effect.orDie);
            yield* Deferred.succeed(continued, agent.continuation);
            yield* writeOnce(agent);
            return finished;
          }),
        yield* Effect.scope,
      );
      const outcome = yield* second(
        Effect.gen(function* () {
          // Starting up marks the cut-off chat run failed; it ran no tool with an unknown result.
          yield* chatRun("run-1", "failed");
          return yield* (yield* CardAttempts).awaitOutcome(payload);
        }),
      );
      yield* Scope.close(crashed, Exit.void);

      expect(yield* Deferred.await(continued)).toBe(true);
      expect(yield* Ref.get(writes)).toBe(1);
      expect(outcome).toMatchObject({ _tag: "Completed", report: "done" });
      expect(board.goalInstanceId.length).toBeGreaterThan(0);
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
    expect(outcome).toEqual({ _tag: "Fenced", runId: "run-0" });
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
    expect(outcome).toEqual({ _tag: "Superseded" });
    expect(yield* Ref.get(ran)).toEqual(["a"]);
  }).pipe(withNode),
);
