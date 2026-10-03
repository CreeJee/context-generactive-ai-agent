import { MessageChannel, Worker, type WorkerOptions } from "node:worker_threads";
import { Effect, Schema } from "effect";
import { serveOwnerRpcPort } from "./owner-rpc-transport.ts";

export class WorkerLifecycleError extends Schema.TaggedError<WorkerLifecycleError>()(
  "WorkerLifecycleError",
  { operation: Schema.Literals(["acquire", "terminate", "cancel"]), cause: Schema.Defect() },
) {}

export const acquireFullLoopChannel = Effect.fn("acquireFullLoopChannel")(function* () {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => new MessageChannel(),
      catch: (cause) => new WorkerLifecycleError({ operation: "acquire", cause }),
    }),
    (channel) =>
      Effect.sync(() => channel.port1.close()).pipe(
        Effect.ensuring(Effect.sync(() => channel.port2.close())),
      ),
  );
});

export const acquireFullLoopEndpoint = Effect.fn("acquireFullLoopEndpoint")(function* (
  port: Parameters<typeof serveOwnerRpcPort>[0],
  options: Parameters<typeof serveOwnerRpcPort>[1],
) {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => serveOwnerRpcPort(port, options),
      catch: (cause) => new WorkerLifecycleError({ operation: "acquire", cause }),
    }),
    (endpoint) => Effect.sync(() => endpoint.close()),
  );
});

export const acquireFullLoopWorker = Effect.fn("acquireFullLoopWorker")(function* (
  url: URL,
  options: WorkerOptions,
  hooks: {
    readonly onWorkerStarting?: () => void;
    readonly onWorkerStopped?: () => void;
  },
) {
  const lease = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        hooks.onWorkerStarting?.();
        return { workerCreated: false, terminated: false };
      },
      catch: (cause) => new WorkerLifecycleError({ operation: "acquire", cause }),
    }),
    (lease) =>
      Effect.sync(() => {
        // Failed construction releases the lease; rejected termination retains it.
        if (!lease.workerCreated || lease.terminated) hooks.onWorkerStopped?.();
      }),
  );
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const worker = new Worker(url, options);
        lease.workerCreated = true;
        return worker;
      },
      catch: (cause) => new WorkerLifecycleError({ operation: "acquire", cause }),
    }),
    (worker) =>
      Effect.tryPromise({
        try: () => worker.terminate(),
        catch: (cause) => new WorkerLifecycleError({ operation: "terminate", cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            lease.terminated = true;
          }),
        ),
        Effect.orDie,
      ),
  );
});
