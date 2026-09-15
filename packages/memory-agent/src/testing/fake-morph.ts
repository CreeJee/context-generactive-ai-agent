import { Effect, Layer } from "effect";
import { MorphAnalyzer } from "../memory/morph/analyzer.ts";

/** Common Korean particles and endings, longest first, stripped from word ends. */
const suffixes = [
  "했었지",
  "하기로",
  "했다",
  "이에요",
  "에서",
  "으로",
  "로",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "도",
].toSorted((a, b) => b.length - a.length);

/**
 * Deterministic stand-in for Kiwi: words split on non-letters, lowercased, with a few particles and
 * endings stripped. Enough for tests of the morpheme channel; not an analyzer.
 */
export function fakeTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => {
      const suffix = suffixes.find(
        (ending) => word.length > ending.length && word.endsWith(ending),
      );
      return suffix ? word.slice(0, -suffix.length) : word;
    });
}

export const fakeMorphLayer = Layer.succeed(MorphAnalyzer, {
  identity: "fake-morph-v1",
  ready: () => true,
  warm: () => undefined,
  terms: (texts) => Effect.sync(() => texts.map(fakeTerms)),
});
