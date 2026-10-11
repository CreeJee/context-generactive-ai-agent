import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";

/** Build filesystem services in the entry point's Scope and retain its other requirements. */
export const withTestPlatform = Effect.fn("withTestPlatform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer),
  );
  return yield* Effect.provideContext(program, services);
});
