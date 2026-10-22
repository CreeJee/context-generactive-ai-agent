import { Schema } from "effect";
import { Transferable } from "effect/workers";

/** A vector the worker transport moves by transferring its buffer, not by copying. */
export const TransferredVector = Transferable.schema(Schema.instanceOf(Float32Array), (values) => [
  values.buffer,
]);

// Flat SDK DTOs are not the public MemorySearch policy. Host-prepared term groups preserve
// UTF-16 classification; no all-candidate seq list exists in this boundary.
const Count = Schema.Int.check(Schema.makeFilter((value) => value >= 0));
const Budget = Schema.Finite.check(Schema.makeFilter((value) => value >= 0 && value <= 2_000));
const Bytes = Count.check(Schema.makeFilter((value) => value <= 1_048_576));
const ids = Schema.Array(Schema.String);
const elapsed = Schema.Finite.check(Schema.makeFilter((value) => value >= 0));
/** Same bound as the native `admitted`: a larger vector k fails the whole read. */
export const maxVectorK = 48;

export const NativeReadInput = Schema.Struct({
  allowedProjects: ids,
  embedder: Schema.String,
  query: Schema.optional(TransferredVector),
  trigramTerms: ids,
  shortTerms: ids,
  morphTerms: ids,
  vectorK: Count.check(Schema.makeFilter((value) => value <= maxVectorK)),
  textK: Count,
  morphK: Count,
  textEnabled: Schema.Boolean,
  morphEnabled: Schema.Boolean,
  remainingMs: Budget,
  inputBudgetBytes: Bytes,
  outputBudgetBytes: Bytes,
});
export type NativeReadInput = typeof NativeReadInput.Type;

/** Logical DTO accounting at the pre-copy boundary, not serialized wire bytes. */
export function nativeReadInputLogicalBytes(input: NativeReadInput): number {
  const limit = input.inputBudgetBytes;
  // Charge fixed per-entry overhead before scanning strings; empty entries cannot
  // hide an unbounded array behind a zero-content-byte budget.
  const entries =
    1 +
    input.allowedProjects.length +
    input.trigramTerms.length +
    input.shortTerms.length +
    input.morphTerms.length;
  let bytes = 64 + (input.query?.byteLength ?? 0) + entries * 8;
  if (bytes > limit) return limit + 1;
  for (const group of [
    [input.embedder],
    input.allowedProjects,
    input.trigramTerms,
    input.shortTerms,
    input.morphTerms,
  ]) {
    for (const value of group) {
      if (bytes > limit || value.length > limit - bytes) return limit + 1;
      bytes += Buffer.byteLength(value, "utf8");
    }
  }
  return bytes;
}

export const NativeReadOutput = Schema.Struct({
  kind: Schema.Literals([
    "success",
    "cancelled",
    "budget-exceeded",
    "invalid-input",
    "read-failed",
    "index-failed",
  ]),
  vectorIds: ids,
  vectorSeqs: ids,
  vectorScores: Schema.Array(Schema.Finite),
  vectorUnavailable: Schema.Boolean,
  textIds: ids,
  morphIds: ids,
  unindexed: Count,
  uninterpreted: Count,
  candidateCount: Count,
  sqliteExecutions: Count,
  candidateMs: elapsed,
  vectorMs: elapsed,
  textMs: elapsed,
  morphMs: elapsed,
  mappingMs: elapsed,
  coverageMs: elapsed,
  inputLogicalBytes: Bytes,
  outputLogicalBytes: Bytes,
});
export type NativeReadOutput = typeof NativeReadOutput.Type;
