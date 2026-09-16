import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { SecretRedactor, mergeFindings } from "../src/secrets/redactor.ts";

/**
 * Keys are assembled at run time so this file holds nothing shaped like a real key; repository
 * scanners (and this app's own redactor, reading its own source) would otherwise flag it.
 */
const repeat = (length: number, character: string) => character.repeat(length);
const fake = {
  openai: ["sk", "proj", `${repeat(58, "a")}T3Blbk${"FJ"}${repeat(58, "b")}`].join("-"),
  anthropic: ["sk", "ant", "api03", `${repeat(93, "c")}AA`].join("-"),
  github: `${"gh"}p_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
  // The rule wants what a real key has: 100+ characters of base64 starting with an ASN.1 SEQUENCE
  // (`MI…`), so placeholders like `...` or `xxx` are not reported.
  privateKey: [
    `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
    `MII${repeat(61, "E")}`,
    repeat(64, "N"),
    `-----END ${"RSA"} PRIVATE KEY-----`,
  ].join("\n"),
};

const redact = (text: string) =>
  Effect.runPromise(
    Effect.flatMap(SecretRedactor, (redactor) => redactor.redactText(text)).pipe(
      Effect.provide(SecretRedactor.layer),
    ),
  );

describe("SecretRedactor", () => {
  test("hides provider keys by their format", async () => {
    const text = [
      `client = OpenAI(api_key="${fake.openai}")`,
      `anthropic ${fake.anthropic}`,
      `remote: ${fake.github}`,
      "postgres://app:hunter2hunter2@db.internal:5432/app",
      fake.privateKey,
    ].join("\n");
    const { text: out, hidden } = await redact(text);
    expect(out).not.toContain(fake.openai);
    expect(out).not.toContain(fake.anthropic);
    expect(out).not.toContain(fake.github);
    expect(out).not.toContain("hunter2hunter2");
    expect(out).not.toContain(repeat(64, "N"));
    expect(out).toContain("[redacted:openai]");
    expect(out).toContain("[redacted:github]");
    expect(hidden).toBeGreaterThanOrEqual(5);
  });

  test("hides a value printed next to a credential-looking name, whatever its format", async () => {
    const cases = [
      ["KAGI_API_KEY=kg9f2c4e1a7b", "KAGI_API_KEY=[redacted:credential]"],
      ['export DB_PASSWORD="correct-horse-battery"', 'export DB_PASSWORD="[redacted:credential]"'],
      ['{"SERVICE_TOKEN": "tk_live_0a1b2c3d"}', '{"SERVICE_TOKEN": "[redacted:credential]"}'],
      ['password: "hunter2hunter2"', 'password: "[redacted:credential]"'],
      ["api_key = 'ak-99887766'", "api_key = '[redacted:credential]'"],
    ] as const;
    for (const [input, expected] of cases) expect((await redact(input)).text).toBe(expected);
  });

  test("leaves the text a coding agent reads all day alone", async () => {
    const untouched = [
      "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "session 01a0a8f6-4a60-7f01-93e6-acf3b7f65b57 commit d36221d",
      "const tokenCount = totalTokens;",
      "const API_KEY = process.env.API_KEY;",
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "password: getPassword()",
      "PASSWORD=short",
      "API_KEY=changeme",
      "apiKey: config.apiKey,",
      "The token limit is 2048 and the secret is to batch.",
    ];
    for (const text of untouched) expect(await redact(text)).toEqual({ text, hidden: 0 });
  });

  test("redacting twice changes nothing more", async () => {
    const once = await redact(`OPENAI_API_KEY=${fake.openai}`);
    expect(once.hidden).toBe(1);
    expect(await redact(once.text)).toEqual({ text: once.text, hidden: 0 });
  });

  test("keeps the structure of a tool result and hides secrets in any string of it", async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(SecretRedactor, (redactor) =>
        redactor.redactResult({
          command: "env",
          exitCode: 0,
          truncated: false,
          stdout: `HOME=/Users/someone\nGITHUB_TOKEN=${fake.github}`,
          files: [{ path: "a.txt", note: `token ${fake.github}` }],
          signal: null,
        }),
      ).pipe(Effect.provide(SecretRedactor.layer)),
    );
    expect(result).toEqual({
      command: "env",
      exitCode: 0,
      truncated: false,
      stdout: "HOME=/Users/someone\nGITHUB_TOKEN=[redacted:github]",
      files: [{ path: "a.txt", note: "token [redacted:github]" }],
      signal: null,
    });
  });

  test("large output stays fast", async () => {
    const log = `${"2026-09-16T10:00:00Z INFO handled path=/api/items id=01a0a8f6 in 12ms\n".repeat(3000)}GITHUB_TOKEN=${fake.github}\n`;
    const started = performance.now();
    const { hidden } = await redact(log);
    expect(hidden).toBe(1);
    // About 4 ms on a laptop; the bound only catches a pathological regex.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("mergeFindings", () => {
  test("joins overlapping spans and prefers the provider's name", () => {
    expect(
      mergeFindings([
        { start: 10, end: 30, kind: "credential" },
        { start: 12, end: 30, kind: "github" },
        { start: 40, end: 45, kind: "credential" },
        { start: 44, end: 50, kind: "aws" },
        { start: 60, end: 62, kind: "slack" },
      ]),
    ).toEqual([
      { start: 10, end: 30, kind: "github" },
      { start: 40, end: 50, kind: "aws" },
      { start: 60, end: 62, kind: "slack" },
    ]);
  });
});
