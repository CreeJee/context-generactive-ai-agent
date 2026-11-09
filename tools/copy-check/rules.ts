// What app copy may say. Every entry is a fixed pattern with a reason and a fix, so a finding
// tells the writer (often a coding agent) what to write instead.

/** A phrase pattern that copy must not contain. */
export interface PhraseRule {
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * Phrases that stay wrong whatever the screen says. The list holds only stable patterns
 * (translationese, punctuation, inflated politeness); style that drifts with each model generation
 * belongs in examples, not here.
 */
export const phraseRules = {
  "translationese-through": {
    pattern: /[을를]\s*통(해|하여|한)/u,
    message: "'~을 통해'는 번역투예요. '~로', '~에서'처럼 조사로 쓰세요.",
  },
  "double-passive": {
    pattern: /(되어|하여)[지진져졌짐]/u,
    message: "이중 피동이에요. '되다', '하다' 한 번만 쓰세요.",
  },
  "contracted-doeeoyo": {
    pattern: /되어요/u,
    message: "'되어요'는 '돼요'로 줄여 쓰세요.",
  },
  "inflated-honorific": {
    pattern: /시겠어요|시겠습니까|께서/u,
    message: "경어가 과해요. '~할까요?', '~가'처럼 쓰세요.",
  },
  "filler-successfully": {
    pattern: /성공적으로/u,
    message: "'성공적으로'는 정보가 없어요. 무엇이 됐는지만 쓰세요.",
  },
  dash: {
    pattern: /[—–]/u,
    message: "줄표 대신 문장을 나누거나 쉼표를 쓰세요.",
  },
  exclamation: {
    pattern: /!/u,
    message: "느낌표는 쓰지 않아요. 마침표로 끝내세요.",
  },
  emoji: {
    pattern: /\p{Extended_Pictographic}/u,
    message: "이모지는 쓰지 않아요. 아이콘이 필요하면 컴포넌트로 넣으세요.",
  },
} as const satisfies Readonly<Record<string, PhraseRule>>;

/** One concept and the single way copy names it. */
export interface GlossaryEntry {
  readonly use: string;
  readonly avoid: ReadonlyArray<string>;
}

/**
 * Domain terms with one spelling across the app. Add an entry only once the term is decided;
 * the decisions are recorded in docs/decisions.md ("UI 문구 카탈로그").
 */
export const glossary: Readonly<Record<string, GlossaryEntry>> = {};

/** Kiwi tags whose morpheme ends a sentence: final endings, and connective endings before a full stop. */
export const finalEndingTag = "EF";

/**
 * Sentence endings copy may use: 해요체 (`~요`, `~죠`) for sentences, and the noun ending
 * (`없음`) that status labels use.
 */
export function isAllowedEnding(form: string): boolean {
  return form.endsWith("요") || form === "죠" || form === "음" || form === "ᆷ";
}
