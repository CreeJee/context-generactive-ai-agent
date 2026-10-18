import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { expect } from "vite-plus/test";
import type { ChunkSpan } from "./chunks.ts";
import { modelWorker, type ModelSession } from "./embedder.ts";

type Sent = {
  readonly session: number;
  readonly texts: readonly string[];
  readonly reply: Deferred.Deferred<readonly (readonly ChunkSpan[])[]>;
};

/** Sessions whose chunk requests wait for the test to answer them. */
const fixture = Effect.gen(function* () {
  const sent = yield* Queue.make<Sent>();
  const terminations: number[] = [];
  const terminate: Array<Effect.Effect<void>> = [];
  let sessions = 0;
  const connect = () =>
    Effect.sync((): ModelSession => {
      const session = sessions++;
      return {
        device: "cpu",
        countTokens: () => Effect.succeed([]),
        embed: () => Effect.succeed(new Float32Array()),
        chunk: (texts) =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<readonly (readonly ChunkSpan[])[]>();
            yield* Queue.offer(sent, { session, texts, reply });
            return yield* Deferred.await(reply);
          }),
        terminate: Effect.suspend(() => {
          terminations.push(session);
          return terminate[session] ?? Effect.void;
        }),
        busy: (work) => work,
      };
    });
  const model = yield* modelWorker(
    "/unused-test-model-cache",
    { variant: "quint8", devices: ["cpu"] },
    connect,
  );
  return { sent, terminations, terminate, sessions: () => sessions, model };
});

it.effect("bounds concurrent requests and removes a cancelled waiter before dispatch", () =>
  Effect.gen(function* () {
    const { sent, terminations, sessions, model } = yield* fixture;
    const calls = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, i) => i),
      (i) => Effect.forkChild(model.chunks([String(i)]), { startImmediately: true }),
    );
    expect(sessions()).toBe(1);
    expect(yield* Queue.size(sent)).toBe(1);
    yield* Fiber.interrupt(calls[1]!);
    expect(terminations).toEqual([]);
    for (const i of [0, 2, 3, 4, 5, 6, 7]) {
      const { texts, reply } = yield* Queue.take(sent);
      expect(texts).toEqual([String(i)]);
      yield* Deferred.succeed(reply, [[{ start: i, end: i + 1 }]]);
      expect(yield* Fiber.join(calls[i]!)).toEqual([[{ start: i, end: i + 1 }]]);
    }
    expect(yield* Queue.size(sent)).toBe(0);
    expect(terminations).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "waits for cancelled native work to exit before another agent starts a fresh worker",
  () =>
    Effect.gen(function* () {
      const { sent, terminations, terminate, sessions, model } = yield* fixture;
      const terminating = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      terminate[0] = Deferred.succeed(terminating, undefined).pipe(
        Effect.andThen(Deferred.await(exited)),
      );
      const first = yield* Effect.forkChild(model.chunks(["cancel me"]), {
        startImmediately: true,
      });
      const active = yield* Queue.take(sent);
      const second = yield* Effect.forkChild(model.chunks(["keep me"]), {
        startImmediately: true,
      });
      const cancellation = yield* Effect.forkChild(Fiber.interrupt(first));
      yield* Deferred.await(terminating);
      expect(sessions()).toBe(1);
      expect(yield* Queue.size(sent)).toBe(0);
      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(cancellation);
      const next = yield* Queue.take(sent);
      expect(sessions()).toBe(2);
      expect(next.session).toBe(1);
      expect(next.texts).toEqual(["keep me"]);
      // A late answer from the terminated worker reaches no one.
      yield* Deferred.succeed(active.reply, [[{ start: 99, end: 100 }]]);
      yield* Deferred.succeed(next.reply, [[{ start: 0, end: 7 }]]);
      expect(yield* Fiber.join(second)).toEqual([[{ start: 0, end: 7 }]]);
      expect(terminations).toEqual([0]);
    }).pipe(Effect.scoped),
);
