import { Effect, Layer } from "effect";
import { SdkCancellations } from "../../src/runtime/sdk-cancellation.ts";

/** SDK controllers are linked to the test's Scope, which owns cancellation and cleanup. */
export const sdkCancellation = Effect.gen(function* () {
  const services = yield* Layer.build(SdkCancellations.layer);
  const cancellations = yield* Effect.provideContext(SdkCancellations, services);
  return yield* cancellations.allocate("test_shutdown");
});
