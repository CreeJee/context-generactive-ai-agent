import { Worker } from "node:worker_threads";
import { Effect, Exit, Queue, Scope } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { acquireFullLoopWorkerEvents } from "../src/agent/full-loop-worker-events.ts";

test("scoped worker handoff preserves FIFO and removes all listeners", async () => {
  const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
  const scope = Effect.runSync(Scope.make());
  const controller = new AbortController();
  try {
    const queue = await Effect.runPromise(
      acquireFullLoopWorkerEvents(worker, controller.signal).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    worker.emit("message", { type: "chunk", chunk: { type: "TEXT_MESSAGE_CONTENT" } });
    worker.emit("message", { type: "done" });
    worker.emit("exit", 0);
    expect(await Effect.runPromise(Queue.take(queue))).toEqual({
      type: "chunk",
      chunk: { type: "TEXT_MESSAGE_CONTENT" },
    });
    expect(await Effect.runPromise(Queue.take(queue))).toEqual({ type: "done" });
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await worker.terminate();
  }
});

test("failed abort transport wakes the pending pull as failure without escaping its callback", async () => {
  const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
  const scope = Effect.runSync(Scope.make());
  const controller = new AbortController();
  const dispatch = vi.spyOn(worker, "postMessage").mockImplementation(() => {
    throw new Error("closed abort transport");
  });
  try {
    const queue = await Effect.runPromise(
      acquireFullLoopWorkerEvents(worker, controller.signal).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    const pending = Effect.runPromise(Queue.take(queue));
    controller.abort();
    expect(await pending).toEqual({ type: "failed" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    dispatch.mockRestore();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await worker.terminate();
  }
});

test("abort wakes pending take and malformed envelopes fail closed", async () => {
  for (const trigger of ["abort", "invalid"] as const) {
    const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
    const scope = Effect.runSync(Scope.make());
    const controller = new AbortController();
    try {
      const queue = await Effect.runPromise(
        acquireFullLoopWorkerEvents(worker, controller.signal).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      const pending = Effect.runPromise(Queue.take(queue));
      if (trigger === "abort") controller.abort();
      else worker.emit("message", { type: "not-a-frame" });
      expect(await pending).toEqual({ type: trigger === "abort" ? "aborted" : "failed" });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await worker.terminate();
    }
  }
});
