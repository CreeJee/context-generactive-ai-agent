import type { AnyServerTool } from "@tanstack/ai";
import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { creator as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Json } from "../codex/app-server.ts";

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
  const found: Finding[] = [];
  for (const pattern of [environmentAssignment, quotedConfigValue])
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? "";
      if (notASecret.some((exclusion) => exclusion.test(value))) continue;
      const end = (match.index ?? 0) + match[0].length;
      // The value is the last capture; the closing quote of a quoted value follows it.
      const valueEnd = match[0].endsWith(value) ? end : end - 1;
      found.push({ start: valueEnd - value.length, end: valueEnd, kind: "credential" });
    }
  return found;
}

/** `@secretlint/secretlint-rule-github` → `github`. */
const kindOf = (ruleId: string) => ruleId.replace(/^.*secretlint-rule-/u, "");

async function formatFindings(text: string): Promise<Finding[]> {
  const result = await lintSource({
    source: { filePath: "text.txt", content: text, ext: ".txt", contentType: "text" },
    options: {
      config: {
        rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: recommendedRules }],
      },
    },
  });
  return result.messages.map((message) => ({
    start: message.range[0],
    end: message.range[1],
    kind: kindOf(message.ruleId),
  }));
}

/**
 * Overlapping findings joined into one span. Both detectors often report the same key; replacing
 * the spans one by one would cut into text a previous replacement already moved.
 */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Finding[] = [];
  for (const finding of sorted) {
    const last = merged.at(-1);
    if (!last || finding.start >= last.end) {
      merged.push(finding);
      continue;
    }
    // A provider's name says more than "credential", so it wins.
    merged[merged.length - 1] = {
      start: last.start,
      end: Math.max(last.end, finding.end),
      kind: last.kind === "credential" ? finding.kind : last.kind,
    };
  }
  return merged;
}

function replaceFindings(text: string, findings: readonly Finding[]): string {
  let out = "";
  let at = 0;
  for (const finding of findings) {
    out += `${text.slice(at, finding.start)}[redacted:${finding.kind}]`;
    at = finding.end;
  }
  return out + text.slice(at);
}

const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);

const JsonValue: Schema.Schema<Json> = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.suspend((): Schema.Schema<Json> => JsonValue)),
  Schema.Record({
    key: Schema.String,
    value: Schema.suspend((): Schema.Schema<Json> => JsonValue),
  }),
);
const decodeJson = Schema.decodeUnknownOption(JsonValue);

const make = Effect.sync(() => {
  // secretlint profiles every lint by default: each check leaves about 60 entries in the global
  // performance buffer and in the profiler's own arrays, never cleared. Over a sweep or an import
  // that is a leak, and Node warns (MaxPerformanceEntryBufferExceededWarning). Nothing reads them.
  secretLintProfiler.setEnabled(false);

  const redactText = (text: string) =>
    Effect.promise(async (): Promise<Redaction> => {
      if (text.length === 0) return { text, hidden: 0 };
      const findings = mergeFindings([
        ...(await formatFindings(text)),
        ...assignmentFindings(text),
      ]);
      if (findings.length === 0) return { text, hidden: 0 };
      return { text: replaceFindings(text, findings), hidden: findings.length };
    });

  const redactJson = (value: Json): Effect.Effect<Json> => {
    if (isString(value)) return Effect.map(redactText(value), (redaction) => redaction.text);
    if (value === null || isNumber(value) || isBoolean(value)) return Effect.succeed(value);
    if (Array.isArray(value)) return Effect.all(value.map(redactJson));
    return Effect.map(
      Effect.all(
        Object.entries(value).map(([key, item]) =>
          Effect.map(redactJson(item), (redacted) => [key, redacted] as const),
        ),
      ),
      (entries) => Object.fromEntries(entries),
    );
  };

  /**
   * A tool's result with its secrets hidden, keeping its structure. A result that is not plain
   * JSON (nothing this app's tools return) is passed through.
   */
  const redactResult = <A>(result: A) =>
    Option.match(decodeJson(result), {
      onNone: () => Effect.succeed<A | Json>(result),
      onSome: (json) => Effect.map(redactJson(json), (redacted): A | Json => redacted),
    });

  const hide = (text: string) =>
    Effect.runPromise(Effect.map(redactText(text), (redaction) => redaction.text));

  return {
    redactText,
    redactJson,
    redactResult,

    /**
     * The same tools, with secrets hidden in what they return and in the errors they throw, before
     * either reaches the model, the page or memory. Every tool is covered — the shell, file reads,
     * web pages, MCP servers, other agents — because any of them can print a key.
     */
    withHiddenResults(tools: readonly AnyServerTool[]): AnyServerTool[] {
      return tools.map((tool): AnyServerTool => {
        const execute = tool.execute;
        if (!execute) return tool;
        return {
          ...tool,
          execute: async (...call: Parameters<typeof execute>) => {
            let result: Awaited<ReturnType<typeof execute>>;
            try {
              result = await execute(...call);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              const message = await hide(error.message);
              if (message === error.message) throw error;
              throw new Error(message, { cause: "secret hidden from the message" });
            }
            return Effect.runPromise(redactResult(result));
          },
        };
      });
    },
  };
});

/** Hides secrets in what the model reads and in what memory keeps. */
export class SecretRedactor extends Context.Tag("memory-agent/SecretRedactor")<
  SecretRedactor,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(SecretRedactor, make);
}
