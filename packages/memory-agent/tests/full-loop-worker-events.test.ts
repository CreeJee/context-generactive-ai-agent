import { it } from "@effect/vitest";
import { Worker } from "node:worker_threads";
import { Effect, Exit, Fiber, Queue, Scope } from "effect";
import { expect, vi } from "vite-plus/test";
import { acquireFullLoopWorkerEvents } from "../src/agent/full-loop-worker-events.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

const workerFixture = Effect.acquireRelease(
  Effect.sync(() => new Worker("setInterval(() => {}, 1000)", { eval: true })),
  (worker) => Effect.promise(() => worker.terminate()),
);

it.live("scoped worker handoff preserves FIFO and removes all listeners", () =>
  Effect.gen(function* () {
    const worker = yield* workerFixture;
    const scope = yield* Scope.fork(yield* Effect.scope);
    const { controller } = yield* sdkCancellation;
    const queue = yield* acquireFullLoopWorkerEvents(worker, controller.signal).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    worker.emit("message", { type: "chunk", chunk: { type: "TEXT_MESSAGE_CONTENT" } });
    worker.emit("message", { type: "done" });
    worker.emit("exit", 0);
    expect(yield* Queue.take(queue)).toEqual({
      type: "chunk",
      chunk: { type: "TEXT_MESSAGE_CONTENT" },
    });
    expect(yield* Queue.take(queue)).toEqual({ type: "done" });
    yield* Scope.close(scope, Exit.void);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  }),
);

it.live(
  "failed abort transport wakes the pending pull as failure without escaping its callback",
  () =>
    Effect.gen(function* () {
      const worker = yield* workerFixture;
      const { controller } = yield* sdkCancellation;
      const dispatch = vi.spyOn(worker, "postMessage").mockImplementation(() => {
        throw new Error("closed abort transport");
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => dispatch.mockRestore()));
      const queue = yield* acquireFullLoopWorkerEvents(worker, controller.signal);
      const pending = yield* Effect.forkScoped(Queue.take(queue), { startImmediately: true });
      controller.abort();
      expect(yield* Fiber.join(pending)).toEqual({ type: "failed" });
      expect(dispatch).toHaveBeenCalledTimes(1);
    }),
);

it.live("abort wakes pending take and malformed envelopes fail closed", () =>
  Effect.forEach(["abort", "invalid"] as const, (trigger) =>
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* workerFixture;
        const { controller } = yield* sdkCancellation;
        const queue = yield* acquireFullLoopWorkerEvents(worker, controller.signal);
        const pending = yield* Effect.forkScoped(Queue.take(queue), { startImmediately: true });
        if (trigger === "abort") controller.abort();
        else worker.emit("message", { type: "not-a-frame" });
        expect(yield* Fiber.join(pending)).toEqual({
          type: trigger === "abort" ? "aborted" : "failed",
        });
      }),
    ),
  ),
);
