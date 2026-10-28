import { nativePromise } from "../runtime/native-effect.ts";
import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { creator as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";
import { Array as Arr, Context, Effect, Layer, Match, Option, Schema } from "effect";
import { JsonValue, type JsonValue as Json } from "../json.ts";
import { fallbackLogged } from "../runtime/logged-failures.ts";
import type { ShownFailure } from "../runtime/shown-failure.ts";
import { ToolFailed, withDetail } from "../tools/failure.ts";
import type { PreparedCall, RunTool } from "../tools/run-tool.ts";
import { placeholderOf, type HiddenSpan, type RedactedView } from "./restore.ts";

/**
 * Hides secrets in text before a model reads it or memory keeps it.
 *
 * Two detectors, merged:
 * - secretlint's recommended preset finds keys by their provider's format — OpenAI, Anthropic,
 *   AWS, GCP, GitHub, Slack, Stripe, private keys, connection strings with passwords and about
 *   thirty more. Its rules are exact, so hashes, UUIDs and commit ids are left alone, and the
 *   documented example keys (AWS's `AKIAIOSFODNN7EXAMPLE`) are not reported.
 * - A value printed next to a credential-looking name (`API_KEY=…`, `"password": "…"`) is hidden
 *   whatever its format. This covers keys no rule knows, like this app's own Kagi key.
 *
 * Names alone never decide: a model cannot tell which environment variables are secret, and
 * neither can a list of names. What is hidden is a value that was actually printed.
 */

/** A span of text that holds a secret. `kind` is what the replacement says it was. */
interface Finding {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

export interface Redaction {
  readonly text: string;
  /** How many secrets were hidden; 0 means the text came back unchanged. */
  readonly hidden: number;
}

export class SecretRedactionFailed extends Schema.TaggedError<
  SecretRedactionFailed,
  { readonly brand: unique symbol }
>()("SecretRedactionFailed", { cause: Schema.Defect() }) {}

const credentialName =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|SESSION_?KEY|AUTH)";

/**
 * A value as secrets are written: no spaces, quotes or the punctuation code uses. Requiring eight
 * characters leaves `PASSWORD=` followed by a short flag or a number alone.
 */
const secretValue = "[A-Za-z0-9+/=_\\-.~:@!#%^&]{8,}";

/**
 * `NAME=value` and `NAME: value` with an environment-style name (upper case), optionally quoted:
 * shell output, `.env`-like text, JSON with such keys. Case-sensitive on purpose, so code such as
 * `const tokenCount = total` is not a match.
 */
const environmentAssignment = new RegExp(
  `\\b[A-Z0-9_]*${credentialName}[A-Z0-9_]*["']?\\s*[=:]\\s*["']?(${secretValue})`,
  "g",
);

/**
 * A lower-case config key whose value is quoted: `"password": "…"`, `api_key: '…'`. Only quoted
 * values count, because `password: getPassword()` in code is not a secret.
 */
const quotedConfigValue = new RegExp(
  `["']?\\b(?:password|passwd|passphrase|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)["']?\\s*[=:]\\s*["'](${secretValue})["']`,
  "gi",
);

/** Values that are code or placeholders rather than secrets. */
const notASecret = [
  /^(?:process|os|env|import\.meta)\./u,
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u,
  /^(?:x+|\*+|changeme|placeholder|redacted|example|your[_-].*|<.*>)$/iu,
  /^\[redacted:/u,
];

function assignmentFindings(text: string): Finding[] {
  return [environmentAssignment, quotedConfigValue].flatMap((pattern) =>
    Array.from(text.matchAll(pattern)).flatMap((match): Finding[] => {
      const value = match[1] ?? "";
      const end = (match.index ?? 0) + match[0].length;
      // The value is the last capture; the closing quote of a quoted value follows it.
      const valueEnd = match[0].endsWith(value) ? end : end - 1;
      return notASecret.some((exclusion) => exclusion.test(value))
        ? []
        : [{ start: valueEnd - value.length, end: valueEnd, kind: "credential" }];
    }),
  );
}

/** `@secretlint/secretlint-rule-github` → `github`. */
const kindOf = (ruleId: string) => ruleId.replace(/^.*secretlint-rule-/u, "");

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const formatFindings = (text: string) =>
  nativePromise(() =>
    lintSource({
      source: { filePath: "text.txt", content: text, ext: ".txt", contentType: "text" },
      options: {
        config: {
          rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: recommendedRules }],
        },
      },
    }),
  ).pipe(
    Effect.map((result): Finding[] =>
      result.messages.map((message) => ({
        start: message.range[0],
        end: message.range[1],
        kind: kindOf(message.ruleId),
      })),
    ),
  );

/**
 * Overlapping findings joined into one span. Both detectors often report the same key; replacing
 * the spans one by one would cut into text a previous replacement already moved.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  return Arr.reduce(sorted, Arr.empty<Finding>(), (merged, finding) =>
    Option.match(
      Option.filter(Arr.last(merged), (last) => finding.start < last.end),
      {
        onNone: () => [...merged, finding],
        // A provider's name says more than "credential", so it wins.
        onSome: (last) => [
          ...merged.slice(0, -1),
          {
            start: last.start,
            end: Math.max(last.end, finding.end),
            kind: last.kind === "credential" ? finding.kind : last.kind,
          },
        ],
      },
    ),
  );
}

/** The text replaced so far, where the rest starts, and the spans its placeholders hide. */
interface Replacing {
  readonly out: string;
  readonly at: number;
  readonly hidden: ReadonlyArray<HiddenSpan>;
}

function replaceFindings(text: string, findings: readonly Finding[]): RedactedView {
  const start: Replacing = { out: "", at: 0, hidden: [] };
  const { out, at, hidden } = Arr.reduce(findings, start, (state, finding): Replacing => {
    const before = state.out + text.slice(state.at, finding.start);
    const shown = placeholderOf(finding.kind);
    return {
      out: before + shown,
      at: finding.end,
      hidden: [
        ...state.hidden,
        {
          start: before.length,
          end: before.length + shown.length,
          kind: finding.kind,
          value: text.slice(finding.start, finding.end),
        },
      ],
    };
  });
  return { text: out + text.slice(at), hidden };
}

/** What the model reads for a call whose result or failure could not have its secrets hidden. */
const withheld = ToolFailed.make({
  code: "redaction_failed",
  tag: "SecretRedactionFailed",
  detail: "Hiding secrets in what the tool gave failed, so it is not shown.",
});

/** Longest failure detail shown; an agent's or provider's error can carry a whole response. */
const maxShownDetail = 1_000;

const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Finite);
const isBoolean = Schema.is(Schema.Boolean);
const isJsonArray = (value: Json): value is readonly Json[] => Array.isArray(value);

const decodeJson = Schema.decodeUnknownOption(JsonValue);

const make = Effect.sync(() => {
  // secretlint profiles every lint by default: each check leaves about 60 entries in the global
  // performance buffer and in the profiler's own arrays, never cleared. Over a sweep or an import
  // that is a leak, and Node warns (MaxPerformanceEntryBufferExceededWarning). Nothing reads them.
  secretLintProfiler.setEnabled(false);

  /** The text as the model reads it, with the values its placeholders stand for. */
  const redactView = (text: string): Effect.Effect<RedactedView, SecretRedactionFailed> =>
    text.length === 0
      ? Effect.succeed({ text, hidden: [] })
      : formatFindings(text).pipe(
          Effect.mapError((failure) => SecretRedactionFailed.make({ cause: failure.cause })),
          Effect.map((detected) =>
            replaceFindings(text, mergeFindings([...detected, ...assignmentFindings(text)])),
          ),
        );

  const redactText = (text: string) =>
    Effect.map(redactView(text), (view): Redaction => ({
      text: view.text,
      hidden: view.hidden.length,
    }));

  const redactJson = (value: Json): Effect.Effect<Json, SecretRedactionFailed> =>
    Match.value(value).pipe(
      Match.when(isString, (text) => Effect.map(redactText(text), (redaction) => redaction.text)),
      Match.when(Match.null, (empty) => Effect.succeed(empty)),
      Match.when(isNumber, (number) => Effect.succeed(number)),
      Match.when(isBoolean, (flag) => Effect.succeed(flag)),
      Match.when(isJsonArray, (items) => Effect.forEach(items, redactJson)),
      Match.orElse((object) =>
        Effect.map(
          Effect.forEach(Object.entries(object), ([key, item]) =>
            Effect.map(redactJson(item), (redacted) => [key, redacted] as const),
          ),
          (entries) => Object.fromEntries(entries),
        ),
      ),
    );

  /**
   * A tool's result with its secrets hidden, keeping its structure. A result that is not plain
   * JSON (nothing this app's tools return) is passed through.
   */
  const redactResult = <A>(result: A) =>
    Option.match(decodeJson(result), {
      onNone: () => Effect.succeed<A | Json>(result),
      onSome: (json) => Effect.map(redactJson(json), (redacted): A | Json => redacted),
    });

  /**
   * An outside program's own failure text as a person or the model may read it: secrets hidden,
   * then cut short. When hiding fails, the text is not shown at all.
   */
  const shownDetail = (text: string) =>
    redactText(text).pipe(
      Effect.map(({ text: hidden }): string | null =>
        hidden.length > maxShownDetail ? `${hidden.slice(0, maxShownDetail)}…` : hidden,
      ),
      fallbackLogged("Failure detail withheld", () => null),
    );

  /**
   * The call with secrets hidden in its result and in its failure's text. When hiding fails,
   * neither is shown.
   */
  const hiddenCall =
    (run: PreparedCall): PreparedCall =>
    (call) =>
      run(call).pipe(
        Effect.flatMap(redactJson),
        Effect.catchTag("ToolFailed", (failed) =>
          Effect.flatMap(redactText(failed.detail), ({ text }) =>
            Effect.fail(text === failed.detail ? failed : withDetail(failed, text)),
          ),
        ),
        Effect.catchTag("SecretRedactionFailed", () => Effect.fail(withheld)),
      );

  /** The failure with its detail as {@link shownDetail} shows it. */
  const hideDetail = <Code extends string>(
    failure: ShownFailure<Code>,
  ): Effect.Effect<ShownFailure<Code>> =>
    failure.detail === null
      ? Effect.succeed(failure)
      : Effect.map(shownDetail(failure.detail), (detail) => ({ code: failure.code, detail }));

  return {
    redactText,
    redactView,
    redactJson,
    redactResult,
    shownDetail,
    hideDetail,

    /**
     * The same tools, with secrets hidden in what they return and in the errors they fail with,
     * before either reaches the model, the page or memory. Every tool is covered — the shell, file
     * reads, web pages, MCP servers, other agents — because any of them can print a key.
     */
    withHiddenResults: (tools: ReadonlyArray<RunTool>): Array<RunTool> =>
      tools.map((tool) => ({
        ...tool,
        prepare: (params) => Effect.map(tool.prepare(params), hiddenCall),
      })),
  };
});

/** Hides secrets in what the model reads and in what memory keeps. */
export class SecretRedactor extends Context.Service<SecretRedactor, Effect.Success<typeof make>>()(
  "memory-agent/secrets/redactor/SecretRedactor",
) {
  static readonly layer = Layer.effect(SecretRedactor, make);
}
