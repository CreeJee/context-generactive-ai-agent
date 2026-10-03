import type { Worker } from "node:worker_threads";
import { Effect, Queue, Schema } from "effect";

const WorkerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("chunk"), chunk: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("failed") }),
]);

/** Only the transport envelope is decoded here; chunk payloads remain the SDK boundary. */
export const acquireFullLoopWorkerEvents = Effect.fnUntraced(function* (
  worker: Worker,
  signal: AbortSignal,
) {
  const queue = yield* Effect.acquireRelease(
    Queue.unbounded<typeof WorkerFrame.Type | { readonly type: "aborted" }>(),
    (queue) => Queue.shutdown(queue),
  );
  let terminal = false;
  // Node callbacks are a synchronous external boundary; never start detached fibers here.
  const fail = () => {
    if (terminal) return;
    terminal = true;
    Queue.offerUnsafe(queue, { type: "failed" });
  };
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const message = (input: unknown) => {
    if (terminal) return;
    try {
      const frame = Schema.decodeUnknownSync(WorkerFrame)(input);
      if (frame.type !== "chunk") terminal = true;
      Queue.offerUnsafe(queue, frame);
    } catch {
      fail();
    }
  };
  const abort = () => {
    try {
      worker.postMessage({ type: "abort" });
    } catch {
      // EventTarget reports thrown listener errors outside the Effect runtime.
      // A failed transport must wake the consumer as failure, not completion.
      fail();
      return;
    }
    // This is an owner cancellation, not a worker-reported successful completion.
    // Wake a pending Queue.take even if the SDK never replies.
    if (!terminal) {
      terminal = true;
      Queue.offerUnsafe(queue, { type: "aborted" });
    }
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      worker.on("message", message);
      worker.on("error", fail);
      worker.on("exit", fail);
      signal.addEventListener("abort", abort, { once: true });
    }),
    () =>
      Effect.sync(() => {
        signal.removeEventListener("abort", abort);
        worker.off("message", message);
        worker.off("error", fail);
        worker.off("exit", fail);
      }),
  );
  if (signal.aborted) abort();
  return queue;
});
