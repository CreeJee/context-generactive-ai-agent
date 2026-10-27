import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Crypto, Effect, Layer } from "effect";

/** Build filesystem services in the entry point's Scope and retain its other requirements. */
export const withTestPlatform = Effect.fn("withTestPlatform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer),
  );
  return yield* Effect.provideContext(program, services);
});

/** Web Crypto as a Crypto service, for constructors that synchronous fixtures call. */
export const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, Uint8Array.from(data))).pipe(
      Effect.map((digest) => new Uint8Array(digest)),
    ),
});
