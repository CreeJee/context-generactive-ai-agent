import { Effect, Layer } from "effect";
import { RunCancellations } from "../../src/runtime/run-cancellation.ts";

/** Run controllers are linked to the test's Scope, which owns cancellation and cleanup. */
export const runCancellation = Effect.gen(function* () {
  const services = yield* Layer.build(RunCancellations.layer);
  const cancellations = yield* Effect.provideContext(RunCancellations, services);
  return yield* cancellations.allocate("test_shutdown");
});
