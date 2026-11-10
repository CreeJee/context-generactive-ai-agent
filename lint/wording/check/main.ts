// Development tool: checks what Korean wording says (banned phrases, glossary spellings, sentence
// endings), which Lingui does not. It reads the catalogs `lingui extract` writes, and for the Claude
// Code hook the messages of an edited source file. Which files it reads comes from `../policy.ts`.
// Runs from the commit hook, the Claude Code PostToolUse hook, and by hand.
import { matchesGlob } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Array as Arr, Console, Effect, FileSystem, Path, Schema, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/cli";

import { wordingCatalogs, wordingExempt, wordingScope } from "../policy.ts";
import { checkMessages } from "./check.ts";
import type { Finding } from "./check.ts";
import { catalogMessages, sourceMessages } from "./messages.ts";
import type { Message } from "./messages.ts";
import { morphemesLive } from "./morphemes.ts";

/** Some wording breaks the rules; the findings are already printed. */
class WordingViolations extends Schema.TaggedError<WordingViolations>()("WordingViolations", {
  count: Schema.Int,
}) {
  override get message() {
    return `문구 규칙 위반 ${this.count}건`;
  }
}

const matchesAny = (file: string, globs: ReadonlyArray<string>) =>
  globs.some((glob) => matchesGlob(file, glob));

/** Which messages `file` (a path from the repository root) holds for the check, if any. */
const messagesOf = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (matchesAny(file, wordingCatalogs)) {
    return yield* catalogMessages(file, yield* fs.readFileString(file));
  }
  if (/\.tsx?$/.test(file) && matchesAny(file, wordingScope) && !matchesAny(file, wordingExempt)) {
    return yield* sourceMessages(file, yield* fs.readFileString(file));
  }
  return Arr.empty<Message>();
});

/**
 * Findings in `files`. Kiwi loads only when some file holds wording: it takes about two seconds and
 * 900 MB, and most commits and edits touch none.
 */
const findingsOf = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const messages = Arr.flatten(
    yield* Effect.forEach(files, (file) =>
      messagesOf(path.relative(path.resolve("."), path.resolve(file))),
    ),
  );
  if (Arr.isReadonlyArrayEmpty(messages)) return Arr.empty<Finding>();
  return yield* checkMessages(messages).pipe(Effect.provide(morphemesLive));
});

const formatFinding = ({ where, text, rule, message }: Finding) =>
  `${where} "${text}" [${rule}] ${message}`;

const check = Command.make(
  "check",
  {
    files: Argument.String("file").pipe(
      Argument.withDescription(
        "검사할 카탈로그(.po)나 소스 파일 (정책 범위 밖이거나 문구가 없는 파일은 건너뜀)",
      ),
      Argument.atLeast(1),
    ),
  },
  Effect.fn(function* ({ files }) {
    const findings = yield* findingsOf(files);
    yield* Effect.forEach(findings, (finding) => Console.error(formatFinding(finding)), {
      discard: true,
    });
    if (Arr.isReadonlyArrayNonEmpty(findings)) {
      return yield* new WordingViolations({ count: findings.length });
    }
  }),
).pipe(Command.withDescription("Lingui 카탈로그와 소스 파일의 메시지 문구를 검사"));

/** The part of a Claude Code PostToolUse payload this hook reads. */
const HookInput = Schema.Struct({
  tool_input: Schema.Struct({ file_path: Schema.optionalKey(Schema.String) }),
});

const hook = Command.make(
  "hook",
  {},
  Effect.fn(function* () {
    const stdio = yield* Stdio.Stdio;
    const payload = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
    const input = yield* Schema.decodeEffect(Schema.fromJsonString(HookInput))(payload);
    const file = input.tool_input.file_path;
    if (file === undefined) return;
    const findings = yield* findingsOf([file]);
    if (Arr.isReadonlyArrayEmpty(findings)) return;
    // PostToolUse: a "block" decision hands the reason back to the agent, which fixes the wording.
    yield* Console.log(
      JSON.stringify({
        decision: "block",
        reason: [
          "문구 규칙 위반입니다. 아래를 고치십시오 (규칙: lint/wording/policy.ts).",
          ...Arr.map(findings, formatFinding),
        ].join("\n"),
      }),
    );
  }),
).pipe(Command.withDescription("Claude Code PostToolUse hook: 고친 파일의 문구만 검사"));

Command.make("wording-check").pipe(
  Command.withSubcommands([check, hook]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
