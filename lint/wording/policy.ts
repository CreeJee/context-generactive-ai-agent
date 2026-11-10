// The wording policy in one place: where Korean text may live, and what it may say. The lint rule
// (`wording/no-raw-korean`), the wording check (`check/main.ts`), the commit hook and the Claude
// Code hook all read this file. Every content rule is a fixed pattern with a reason and a fix, so
// a finding tells the writer (often a coding agent) what to write instead.

// ---- Where Korean text may live -------------------------------------------------------------

/** Files the rule and the check cover (globs from the repository root). */
export const wordingScope = [
  "apps/agent/app/**",
  "apps/agent/server/**",
  "packages/memory-agent/src/**",
];

/** Files in scope whose Korean is not wording: migration SQL comments and search fixture data. */
export const wordingExempt = [
  "packages/memory-agent/src/db/migrations.ts",
  "packages/memory-agent/src/memory/native-search/read-fixture.ts",
];

/**
 * Lingui macro modules. Text inside their tags, calls and elements (t`…`, msg(…),
 * <Trans>…</Trans>) is a message: extracted to the catalog and checked. The app uses the
 * compile-time macros; server code, which runs without a build step, uses the runtime macro.
 */
export const linguiCoreMacroModules: ReadonlyArray<string> = [
  "@lingui/core/macro",
  "@lingui/core/runtime-macro",
];
export const linguiJsxMacroModules: ReadonlyArray<string> = ["@lingui/react/macro"];
export const linguiMacroModules: ReadonlyArray<string> = [
  ...linguiCoreMacroModules,
  ...linguiJsxMacroModules,
];

/** Object-literal catalogs, kept until their directory moves to Lingui messages. Checked. */
export const catalogFile = /(^|\/)copy\.ts$/;

/** Messages sent to the model in the user's voice. Not wording, so neither linted nor checked. */
export const promptFile = /(^|\/)prompts\.ts$/;

/** Tests, browser tests included, may spell the text they look for on screen. */
export const testFile = /\.(test|spec|browser)\.tsx?$/;

// ---- What the text may say ------------------------------------------------------------------

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
 * the decisions are recorded in docs/decisions.md ("앱 문구는 copy.ts 카탈로그에 두고 …").
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
