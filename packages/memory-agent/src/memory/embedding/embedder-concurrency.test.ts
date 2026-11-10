import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, MutableRef, Queue } from "effect";
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
  const sessions = MutableRef.make(0);
  const connect = () =>
    Effect.sync((): ModelSession => {
      const session = MutableRef.getAndIncrement(sessions);
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
        busy: (work) => work,
      };
    });
  const model = yield* modelWorker(
    "/unused-test-model-cache",
    { mode: "cpu", devices: ["cpu"], purpose: "embedding" },
    connect,
  );
  return { sent, sessions: () => MutableRef.get(sessions), model };
});

it.effect("bounds concurrent requests and removes a cancelled waiter before dispatch", () =>
  Effect.gen(function* () {
    const { sent, sessions, model } = yield* fixture;
    const calls = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, i) => i),
      (i) => Effect.forkChild(model.chunks([String(i)]), { startImmediately: true }),
    );
    expect(sessions()).toBe(1);
    expect(yield* Queue.size(sent)).toBe(1);
    yield* Fiber.interrupt(calls[1]!);
    yield* Effect.forEach(
      [0, 2, 3, 4, 5, 6, 7],
      Effect.fnUntraced(function* (i) {
        const { texts, reply } = yield* Queue.take(sent);
        expect(texts).toEqual([String(i)]);
        yield* Deferred.succeed(reply, [[{ start: i, end: i + 1 }]]);
        expect(yield* Fiber.join(calls[i]!)).toEqual([[{ start: i, end: i + 1 }]]);
      }),
      { discard: true },
    );
    expect(yield* Queue.size(sent)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("a cancelled request waits for its worker call and leaves the worker to the next", () =>
  Effect.gen(function* () {
    const { sent, sessions, model } = yield* fixture;
    const first = yield* Effect.forkChild(model.chunks(["cancel me"]), {
      startImmediately: true,
    });
    const active = yield* Queue.take(sent);
    const second = yield* Effect.forkChild(model.chunks(["keep me"]), {
      startImmediately: true,
    });
    const cancelled = yield* Deferred.make<void>();
    const cancellation = yield* Effect.forkChild(
      Fiber.interrupt(first).pipe(Effect.andThen(Deferred.succeed(cancelled, undefined))),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    // Terminating the worker mid-call would abort the process: the call runs to its end first.
    expect(yield* Deferred.isDone(cancelled)).toBe(false);
    expect(yield* Queue.size(sent)).toBe(0);
    yield* Deferred.succeed(active.reply, [[{ start: 99, end: 100 }]]);
    yield* Fiber.join(cancellation);
    const next = yield* Queue.take(sent);
    expect(next.session).toBe(0);
    expect(next.texts).toEqual(["keep me"]);
    yield* Deferred.succeed(next.reply, [[{ start: 0, end: 7 }]]);
    expect(yield* Fiber.join(second)).toEqual([[{ start: 0, end: 7 }]]);
    expect(sessions()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("a request still loading the model stops when it is cancelled", () =>
  Effect.gen(function* () {
    const loading = yield* Deferred.make<void>();
    const model = yield* modelWorker(
      "/unused-test-model-cache",
      { mode: "cpu", devices: ["cpu"], purpose: "embedding" },
      // A model load that never finishes, like a download that hangs.
      () => Deferred.succeed(loading, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const call = yield* Effect.forkChild(model.chunks(["text"]), { startImmediately: true });
    yield* Deferred.await(loading);
    yield* Fiber.interrupt(call);
  }).pipe(Effect.scoped),
);
