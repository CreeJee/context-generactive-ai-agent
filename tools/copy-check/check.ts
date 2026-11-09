import { Array as Arr, Effect, Record as Rec, RegExp as Re, Result } from "effect";

import type { CopyText } from "./extract.ts";
import { Morphemes } from "./morphemes.ts";
import { finalEndingTag, glossary, phraseRules, registers } from "./rules.ts";
import type { GlossaryEntry, Mood } from "./rules.ts";

/** One rule a piece of copy breaks, and what to write instead. */
export interface Violation {
  readonly rule: string;
  readonly message: string;
}

/** A violation at its place in a file. */
export interface Finding extends Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The part of a Kiwi token the ending check reads. */
export interface Morpheme {
  readonly str: string;
  readonly tag: string;
}

/** Banned phrases in `text`. */
export function phraseViolations(text: string): ReadonlyArray<Violation> {
  return Arr.filterMap(Rec.toEntries(phraseRules), ([rule, { pattern, message }]) =>
    pattern.test(text) ? Result.succeed({ rule, message }) : Result.failVoid,
  );
}

const latinWord = /^[\p{Script=Latin}\d\s-]+$/u;

/** Whether `text` contains `term`; a Latin term matches whole words only, ignoring case. */
function mentions(text: string, term: string): boolean {
  return latinWord.test(term)
    ? new RegExp(
        `(?<![\\p{Script=Latin}\\d])${Re.escape(term)}(?![\\p{Script=Latin}\\d])`,
        "iu",
      ).test(text)
    : text.includes(term);
}

/** Spellings in `text` that the glossary replaces with its chosen term. */
export function glossaryViolations(
  text: string,
  entries: Readonly<Record<string, GlossaryEntry>> = glossary,
): ReadonlyArray<Violation> {
  return Arr.flatMap(Rec.values(entries), ({ use, avoid }) =>
    Arr.filterMap(avoid, (term) =>
      mentions(text, term)
        ? Result.succeed({ rule: "glossary", message: `'${term}' 대신 '${use}'로 쓰세요.` })
        : Result.failVoid,
    ),
  );
}

/** The ending that closes one sentence, and whether that sentence asks. */
interface SentenceEnding {
  readonly form: string;
  readonly mood: Mood;
}

/**
 * Endings that close a sentence: final endings, and a connective ending right before punctuation
 * or at the very end (Kiwi reads `저장 중입니다…` with a connective `ᆸ니다`). A sentence asks when
 * a question mark follows or the ending itself is interrogative (`~까`, `~까요`).
 */
function sentenceEndings(morphemes: ReadonlyArray<Morpheme>): ReadonlyArray<SentenceEnding> {
  return Arr.filterMap(morphemes, (morpheme, index) => {
    const next = morphemes[index + 1];
    const closes =
      morpheme.tag === finalEndingTag ||
      (morpheme.tag.startsWith("EC") && (next === undefined || next.tag.startsWith("S")));
    const asks = next?.str === "?" || morpheme.str.includes("까");
    return closes
      ? Result.succeed({ form: morpheme.str, mood: asks ? "question" : "statement" })
      : Result.failVoid;
  });
}

/**
 * Sentences whose ending is outside the register of their mood, and labels (copy with no
 * sentence ending) that end with a full stop.
 */
export function endingViolations(
  text: string,
  morphemes: ReadonlyArray<Morpheme>,
): ReadonlyArray<Violation> {
  const endings = sentenceEndings(morphemes);
  if (Arr.isReadonlyArrayEmpty(endings)) {
    return text.trimEnd().endsWith(".")
      ? [{ rule: "label-period", message: "문장이 아닌 라벨은 마침표 없이 끝내세요." }]
      : [];
  }
  return Arr.filterMap(endings, ({ form, mood }) =>
    registers[mood].allows(form)
      ? Result.failVoid
      : Result.succeed({
          rule: "register",
          message: `'${form}'로 끝나요. ${mood === "question" ? "질문은" : "문장은"} ${registers[mood].expected}로 끝내세요.`,
        }),
  );
}

/** Every violation in each piece of copy of `file`. */
export const checkCopy = Effect.fnUntraced(function* (
  file: string,
  texts: ReadonlyArray<CopyText>,
) {
  const morphemes = yield* Morphemes;
  return Arr.flatMap(texts, ({ text, line, column }) =>
    Arr.map(
      [
        ...phraseViolations(text),
        ...glossaryViolations(text),
        ...endingViolations(text, morphemes.tokenize(text)),
      ],
      (violation): Finding => ({ ...violation, file, line, column }),
    ),
  );
});
