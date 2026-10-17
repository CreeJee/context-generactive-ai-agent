import { Effect, Schema } from "effect";

/** UTF-16 offsets into the unchanged original, suitable for read_evidence(offset). */
export const ChunkSpan = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
});
export type ChunkSpan = typeof ChunkSpan.Type;

export const chunkPolicy = { tokens: 512, overlap: 128, version: 1 } as const;

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
  const spans: ChunkSpan[] = [];
  let start = 0;
  while (start < text.length) {
    let low = start;
    let high = boundary(text, Math.min(text.length, start + chunkPolicy.tokens * 8));
    // Retain only measured, fitting endpoints. Token counts need not be strictly monotonic for
    // this to preserve coverage and the hard bound; a non-monotonic tokenizer may yield less fill.
    while (low < high) {
      let middle = boundary(text, Math.ceil((low + high) / 2));
      if (middle <= low) middle = Math.min(high, low + 2);
      if ((yield* count(text.slice(start, middle), true)) <= chunkPolicy.tokens) low = middle;
      else high = boundary(text, middle - 1);
    }
    const end = low;
    if (end <= start) return yield* ChunkingFailed.make({ reason: "token-limit" });
    spans.push({ start, end });
    if (end === text.length) break;
    low = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
    high = end;
    while (low < high) {
      const middle = boundary(text, Math.floor((low + high) / 2));
      if ((yield* count(text.slice(middle, end), false)) <= chunkPolicy.overlap) high = middle;
      else low = middle + (text.codePointAt(middle)! > 0xffff ? 2 : 1);
    }
    start = high;
  }
  return spans;
});
