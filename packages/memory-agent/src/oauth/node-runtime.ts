import { Crypto, type Effect } from "effect";
import { runNativeEffectWith } from "../runtime/native-effect.ts";
import { nodePlatform, type NodePlatform } from "../runtime/node-platform.ts";

// SDK Promise entry points share the process's platform services. Every child and I/O operation
// acquires its own scope; domain effects consume injectable services directly.
export const runOAuthNodeEffect = <A, E>(program: Effect.Effect<A, E, NodePlatform>) =>
  nodePlatform.context().then((context) => runNativeEffectWith(context)(program));

// PKCE constructors are synchronous protocol boundaries. The stateless Node
// Crypto service is captured once; its digest/random operations are synchronous.
export const oauthProtocolCrypto = nodePlatform.runSync(Crypto.Crypto);
