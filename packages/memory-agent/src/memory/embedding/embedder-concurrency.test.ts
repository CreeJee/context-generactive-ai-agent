import { EventEmitter } from "node:events";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { expect, vi, type Mock } from "vite-plus/test";
import { modelWorker } from "./embedder.ts";

type Request = { id: number; kind: string; texts: readonly string[] };
interface FakeWorker extends EventEmitter {
  ref: Mock<() => void>;
  unref: Mock<() => void>;
  terminate: Mock<() => Promise<number>>;
  postMessage: (request: Request) => void;
}
const fixture = Effect.gen(function* () {
  const sent = yield* Queue.make<{ worker: EventEmitter; request: Request }>();
  const workers: FakeWorker[] = [];
  function create(): FakeWorker {
    const worker = Object.assign(new EventEmitter(), {
      ref: vi.fn(),
      unref: vi.fn(),
      terminate: vi.fn(() => Promise.resolve(0)),
      postMessage: (request: Request) => {
        Queue.offerUnsafe(sent, { worker, request });
      },
    });
    workers.push(worker);
    return worker;
  }
  const embedder = modelWorker(
    "/unused-test-model-cache",
    { variant: "quint8", devices: ["cpu"] },
    create,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => Promise.resolve(embedder.stop("test scope closed"))).pipe(Effect.asVoid),
  );
  return { sent, workers, embedder };
});

it.effect("bounds concurrent requests and removes a cancelled waiter before dispatch", () =>
  Effect.gen(function* () {
    const { sent, workers, embedder } = yield* fixture;
    const calls = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, i) => i),
      (i) => Effect.forkChild(embedder.chunks!([String(i)]), { startImmediately: true }),
    );
    expect(workers).toHaveLength(1);
    expect(yield* Queue.size(sent)).toBe(1);
    yield* Fiber.interrupt(calls[1]!);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    for (const i of [0, 2, 3, 4, 5, 6, 7]) {
      const { worker, request } = yield* Queue.take(sent);
      expect(request.texts).toEqual([String(i)]);
      worker.emit("message", {
        id: request.id,
        kind: "chunks",
        spans: [[{ start: i, end: i + 1 }]],
      });
      expect(yield* Fiber.join(calls[i]!)).toEqual([[{ start: i, end: i + 1 }]]);
    }
    expect(yield* Queue.size(sent)).toBe(0);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect(
  "waits for cancelled native work to exit before another agent starts a fresh worker",
  () =>
    Effect.gen(function* () {
      const { sent, workers, embedder } = yield* fixture;
      const first = yield* Effect.forkChild(embedder.chunks!(["cancel me"]), {
        startImmediately: true,
      });
      const active = yield* Queue.take(sent);
      const terminating = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      workers[0]!.terminate.mockImplementation(() => {
        Deferred.doneUnsafe(terminating, Effect.void);
        return Effect.runPromise(Deferred.await(exited).pipe(Effect.as(0)));
      });
      const second = yield* Effect.forkChild(embedder.chunks!(["keep me"]), {
        startImmediately: true,
      });
      const cancellation = yield* Effect.forkChild(Fiber.interrupt(first));
      yield* Deferred.await(terminating);
      expect(workers).toHaveLength(1);
      expect(yield* Queue.size(sent)).toBe(0);
      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(cancellation);
      const next = yield* Queue.take(sent);
      expect(workers).toHaveLength(2);
      expect(next.request.texts).toEqual(["keep me"]);
      active.worker.emit("message", {
        id: active.request.id,
        kind: "chunks",
        spans: [[{ start: 99, end: 100 }]],
      });
      next.worker.emit("message", {
        id: next.request.id,
        kind: "chunks",
        spans: [[{ start: 0, end: 7 }]],
      });
      expect(yield* Fiber.join(second)).toEqual([[{ start: 0, end: 7 }]]);
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(workers[1]!.terminate).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);
