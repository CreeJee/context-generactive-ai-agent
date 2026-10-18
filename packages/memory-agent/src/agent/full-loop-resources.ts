import { MessageChannel } from "node:worker_threads";
import { Effect, Schema } from "effect";

export class WorkerLifecycleError extends Schema.TaggedError<WorkerLifecycleError>()(
  "WorkerLifecycleError",
  { operation: Schema.Literals(["acquire", "terminate", "cancel"]), cause: Schema.Defect() },
) {}

export const acquireFullLoopChannel = Effect.fn("acquireFullLoopChannel")(function* () {
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => new MessageChannel(),
      catch: (cause) => WorkerLifecycleError.make({ operation: "acquire", cause }),
    }),
    (channel) =>
      Effect.sync(() => channel.port1.close()).pipe(
        Effect.ensuring(Effect.sync(() => channel.port2.close())),
      ),
  );
});
