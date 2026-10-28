import { Array as Arr, Effect, Schema, Stream } from "effect";

/** UTF-16 offsets into the unchanged original, suitable for read_evidence(offset). */
export const ChunkSpan = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
});
export type ChunkSpan = typeof ChunkSpan.Type;

export const chunkPolicy = { tokens: 512, overlap: 128, version: 1 } as const;

/** First `node_vector_chunks.vector_id` (the migration's CHECK); node seqs stay below it. */
export const chunkVectorIdFloor = 2 ** 52;

export class ChunkingFailed extends Schema.TaggedError<
  ChunkingFailed,
  { readonly brand: unique symbol }
>()("ChunkingFailed", {
  reason: Schema.Literals(["tokenization-failed", "token-limit"]),
}) {}

/** Never split a surrogate pair; offsets still use the original string's UTF-16 units. */
function boundary(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

/**
 * The installed tokenizer does not expose source offsets. Count exact original substrings instead
 * of decoding token slices (which can normalize whitespace or break Unicode). Bounded windows
 * keep tokenization memory independent of the full document length. Every accepted span is
 * measured including special tokens; overlap is measured without them.
 */
export const chunkText = Effect.fn("Embedding.chunkText")(function* (
  text: string,
  count: (text: string, specialTokens: boolean) => Effect.Effect<number, ChunkingFailed>,
) {
  /** UTF-16 units of the character at `offset`. */
  const width = (offset: number) => (text.codePointAt(offset)! > 0xffff ? 2 : 1);

  // Both searches halve their range at each step, so their depth stays small.
  /**
   * The farthest end between `low` and `high` whose span from `start` fits. Retain only measured,
   * fitting endpoints. Token counts need not be strictly monotonic for this to preserve coverage
   * and the hard bound; a non-monotonic tokenizer may yield less fill.
   */
  const fittingEnd = (
    start: number,
    low: number,
    high: number,
  ): Effect.Effect<number, ChunkingFailed> => {
    const half = boundary(text, Math.ceil((low + high) / 2));
    const middle = half <= low ? Math.min(high, low + 2) : half;
    return low >= high
      ? Effect.succeed(low)
      : Effect.flatMap(count(text.slice(start, middle), true), (tokens) =>
          tokens <= chunkPolicy.tokens
            ? fittingEnd(start, middle, high)
            : fittingEnd(start, low, boundary(text, middle - 1)),
        );
  };

  /** The earliest start between `low` and `high` whose overlap up to `end` fits. */
  const overlapStart = (
    end: number,
    low: number,
    high: number,
  ): Effect.Effect<number, ChunkingFailed> => {
    const middle = boundary(text, Math.floor((low + high) / 2));
    return low >= high
      ? Effect.succeed(high)
      : Effect.flatMap(count(text.slice(middle, end), false), (tokens) =>
          tokens <= chunkPolicy.overlap
            ? overlapStart(end, low, middle)
            : overlapStart(end, middle + width(middle), high),
        );
  };

  /** The span from `start`, and where the next one starts unless this one reaches the end. */
  const spanFrom = (start: number) =>
    Effect.gen(function* () {
      const end = yield* fittingEnd(
        start,
        start,
        boundary(text, Math.min(text.length, start + chunkPolicy.tokens * 8)),
      );
      yield* Effect.when(
        Effect.fail(ChunkingFailed.make({ reason: "token-limit" })),
        Effect.succeed(end <= start),
      );
      const next = yield* Effect.when(
        overlapStart(end, start + width(start), end),
        Effect.succeed(end < text.length),
      );
      return [Arr.of<ChunkSpan>({ start, end }), next] as const;
    });

  return text.length === 0 ? [] : yield* Stream.runCollect(Stream.paginate(0, spanFrom));
});
