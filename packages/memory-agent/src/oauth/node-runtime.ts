import { NodeServices, NodeCrypto, NodePath, NodeFileSystem } from "@effect/platform-node";
import { Context, Crypto, FileSystem, Path, Effect, Layer, ManagedRuntime } from "effect";
import { runNativeEffectWith } from "../runtime/native-effect.ts";

// SDK Promise entry points share platform services. Every child and I/O operation
// acquires its own scope; domain effects consume injectable services directly.
const runtime = ManagedRuntime.make(NodeServices.layer);

export const runOAuthNodeEffect = <A, E>(program: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  runtime.context().then((context) => runNativeEffectWith(context)(program));

// PKCE constructors are synchronous protocol boundaries. The stateless Node
// Crypto layer is captured once; its digest/random operations are synchronous.
export const oauthProtocolCrypto = Context.get(
  Effect.runSync(Effect.scoped(Layer.build(NodeCrypto.layer))),
  Crypto.Crypto,
);

// Host path normalization is synchronous and platform-specific at SDK boundaries.
export const oauthProtocolPath = Context.get(
  Effect.runSync(Effect.scoped(Layer.build(NodePath.layer))),
  Path.Path,
);

export const oauthProtocolFileSystem = Context.get(
  Effect.runSync(Effect.scoped(Layer.build(NodeFileSystem.layer))),
  FileSystem.FileSystem,
);
