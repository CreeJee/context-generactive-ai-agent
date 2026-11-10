// The Korean wording policy in one place. Where text lives is Lingui's job: messages are written with
// its macros and extracted into catalogs by `lingui extract`, and the official lint rules
// (`eslint-plugin-lingui`) keep text inside messages. What the text says is not: this file holds
// those rules, and the wording check (`check/main.ts`) applies them to the catalogs with Kiwi. The
// lint overrides in the root `vite.config.ts`, the commit hook and the Claude Code hook read it.
// Every content rule is a fixed pattern with a reason and a fix, so a finding tells the writer (often
// a coding agent) what to write instead.

// ---- Where Korean text lives ----------------------------------------------------------------

/** Source files whose Korean text is wording (globs from the repository root). */
export const wordingScope = [
  "apps/agent/app/**",
  "apps/agent/server/**",
  "packages/memory-agent/src/**",
];

/**
 * Files in scope whose Korean is not wording: messages sent to the model in the user's voice
 * (`prompts.ts`), tests that look for text on screen, migration SQL comments and search fixture data.
 */
export const wordingExempt = [
  "**/prompts.ts",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "**/*.browser.{ts,tsx}",
  "packages/memory-agent/src/db/migrations.ts",
  "packages/memory-agent/src/memory/native-search/read-fixture.ts",
];

/**
 * Strings that are not wording, for `lingui/no-unlocalized-strings`: the app speaks Korean only, so a
 * string without Hangul is an identifier, a class name or a protocol value. The rule compiles the
 * pattern without the `u` flag, so Hangul is spelled as code point ranges (jamo, compatibility jamo,
 * syllables).
 */
export const notWording = "^[^\\u1100-\\u11FF\\u3131-\\u318E\\uAC00-\\uD7A3]*$";

/** The catalogs `lingui extract` writes from the messages in scope; the wording check reads them. */
export const wordingCatalogs = [
  "apps/agent/app/locales/*.po",
  "apps/agent/server/locales/*.po",
  "packages/memory-agent/src/locales/*.po",
];

/**
 * Lingui macro modules, for reading the messages of a source file before extraction. The app uses
 * the compile-time macros; server code, which runs without a build step, uses the runtime macro.
 */
export const linguiCoreMacroModules: ReadonlyArray<string> = [
  "@lingui/core/macro",
  "@lingui/core/runtime-macro",
];
export const linguiJsxMacroModules: ReadonlyArray<string> = ["@lingui/react/macro"];

// ---- What the text may say ------------------------------------------------------------------

/** A phrase pattern that wording must not contain. */
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

/** One concept and the single way the wording names it. */
export interface GlossaryEntry {
  readonly use: string;
  readonly avoid: ReadonlyArray<string>;
}

/**
 * Domain terms with one spelling across the app. Add an entry only once the term is decided; the
 * decisions are recorded in docs/decisions.md.
 * A Latin spelling in `avoid` matches without case, so a case variant of `use` never goes there.
 */
export const glossary = {
  // The board's top-level unit keeps its product name, as in the kanban and chat code.
  goal: { use: "Goal", avoid: ["목표"] },
  // A Goal's Plan keeps its product name too.
  plan: { use: "Plan", avoid: ["계획", "플랜"] },
  // What a run produced reads as plain Korean.
  outcome: { use: "결과", avoid: ["outcome"] },
} as const satisfies Readonly<Record<string, GlossaryEntry>>;

/** Kiwi tags whose morpheme ends a sentence: final endings, and connective endings before a full stop. */
export const finalEndingTag = "EF";

/** Punctuation tags that end a sentence: `.`, `?`, `!` (SF) and an ellipsis (SE). */
export const sentenceStopTags: ReadonlyArray<string> = ["SF", "SE"];

/** Whether a sentence asks or tells; each has its own register. */
export type Mood = "question" | "statement";

/** A register a sentence ending must belong to, and how a finding names it. */
export interface Register {
  readonly allows: (form: string) => boolean;
  readonly expected: string;
}

/**
 * Statements and requests are written in 합니다체 (`~습니다`, `~십시오`); status labels may end
 * with the noun ending (`없음`). Questions are softened to 해요체 (`~할까요?`), never `~습니까?`.
 */
export const registers = {
  statement: {
    allows: (form) =>
      form.endsWith("니다") || form.endsWith("시오") || form === "음" || form === "ᆷ",
    expected: "합니다체(~습니다, ~십시오)",
  },
  question: {
    allows: (form) => form.endsWith("요") || form === "죠",
    expected: "해요체(~할까요?)",
  },
} as const satisfies Readonly<Record<Mood, Register>>;
