import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ManagedRuntime, Schema } from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";

// NodeCrypto's digest Effect is synchronous and its Layer owns no external resources.
// Retain one service context for synchronous SQLite transactions and native SDK callbacks.
// This boundary must stay Node-specific: an asynchronous Crypto implementation cannot satisfy it.
const runtime = ManagedRuntime.make(NodeCrypto.layer);
const crypto = runtime.runSync(Digest.Digest);

export const sha256 = (input: string | Uint8Array): string =>
  Hex.encode(
    runtime.runSync(
      crypto.digest(
        Digest.sha256,
        Schema.is(Schema.String)(input) ? new TextEncoder().encode(input) : input,
      ),
    ),
  );
