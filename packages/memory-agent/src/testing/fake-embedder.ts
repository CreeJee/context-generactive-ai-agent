import { Effect, Layer } from "effect";
import { EmbedderRuntime, Embedder, normalize } from "../memory/embedding/embedder.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";

// Match the measured native search admission envelope used by the application.
const dimensions = 384;

/** The first two bytes of the trigram's SHA-256 digest. */
const digestBytes = (trigram: string) => {
  const hex = sha256(trigram);
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16)] as const;
};

/**
 * Deterministic stand-in for the local model: hashes character trigrams into a vector,
 * so texts sharing wording land close together. Lexical, not semantic — tests only.
 */
export const fakeVector = (text: string): Float32Array => {
  const vector = new Float32Array(dimensions);
  const chars = Array.from(
    new Intl.Segmenter().segment(text.toLowerCase().replace(/\s+/g, " ")),
    (part) => part.segment,
  );
  Array.from({ length: Math.max(chars.length - 2, 0) }, (_, i) =>
    digestBytes(chars.slice(i, i + 3).join("")),
  ).forEach(([bucket, sign]) => {
    vector[bucket % dimensions]! += sign % 2 === 0 ? 1 : -1;
  });
  return normalize(vector);
};

export const fakeEmbedderLayer = Layer.succeed(Embedder, {
  identity: "fake-trigram-384",
  dimensions,
  embed: (texts) => Effect.succeed(texts.map(fakeVector)),
  runtime: () => EmbedderRuntime.other(),
});
