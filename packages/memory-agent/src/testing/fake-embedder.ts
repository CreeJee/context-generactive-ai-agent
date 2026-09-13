import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { Embedder, normalize } from "../memory/embedding/embedder.ts";

const dimensions = 64;

/**
 * Deterministic stand-in for the local model: hashes character trigrams into a vector,
 * so texts sharing wording land close together. Lexical, not semantic — tests only.
 */
export function fakeVector(text: string): Float32Array {
  const vector = new Float32Array(dimensions);
  const chars = Array.from(
    new Intl.Segmenter().segment(text.toLowerCase().replace(/\s+/g, " ")),
    (part) => part.segment,
  );
  for (let i = 0; i + 3 <= chars.length; i++) {
    const digest = createHash("sha256")
      .update(chars.slice(i, i + 3).join(""))
      .digest();
    vector[digest[0]! % dimensions]! += digest[1]! % 2 === 0 ? 1 : -1;
  }
  return normalize(vector);
}

export const fakeEmbedderLayer = Layer.succeed(Embedder, {
  identity: "fake-trigram-64",
  dimensions,
  embed: (texts) => Effect.sync(() => texts.map(fakeVector)),
});
