import { NodeCrypto } from "@effect/platform-node";
import { Crypto, Effect, Layer } from "effect";
import { Embedder, EmbeddingError, normalize } from "../memory/embedding/embedder.ts";

// Match the measured native search admission envelope used by the application.
const dimensions = 384;
// NodeCrypto's Layer is a resource-free value and its SHA digest is synchronous.
// Keep that host contract at the synchronous fixture boundary consumed by SQLite helpers.
const cryptoContext = Effect.runSync(Effect.scoped(Layer.build(NodeCrypto.layer)));
const runVector = Effect.runSyncWith(cryptoContext);

/**
 * Deterministic stand-in for the local model: hashes character trigrams into a vector,
 * so texts sharing wording land close together. Lexical, not semantic — tests only.
 */
const vectorEffect = Effect.fn("fakeVector")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const vector = new Float32Array(dimensions);
  const chars = Array.from(
    new Intl.Segmenter().segment(text.toLowerCase().replace(/\s+/g, " ")),
    (part) => part.segment,
  );
  for (let i = 0; i + 3 <= chars.length; i++) {
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(chars.slice(i, i + 3).join("")),
    );
    vector[digest[0]! % dimensions]! += digest[1]! % 2 === 0 ? 1 : -1;
  }
  return normalize(vector);
});

export function fakeVector(text: string): Float32Array {
  return runVector(vectorEffect(text));
}

export const fakeEmbedderLayer = Layer.succeed(Embedder, {
  identity: "fake-trigram-384",
  dimensions,
  embed: (texts) =>
    Effect.forEach(texts, vectorEffect).pipe(
      Effect.provideContext(cryptoContext),
      Effect.mapError((cause) => new EmbeddingError({ cause })),
    ),
  runtime: () => ({ kind: "other" }),
});
