// Development tool: checks what Korean wording says (banned phrases, glossary spellings, sentence
// endings) in Lingui messages and copy.ts catalogs. Which files it reads comes from
// `../policy.ts`. Runs from the commit hook, the Claude Code PostToolUse hook, and by hand.
import { matchesGlob } from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Argument, Command } from "effect/cli";
import { Digest } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import {
  catalogFile,
  linguiMacroModules,
  promptFile,
  testFile,
  wordingExempt,
  wordingScope,
} from "../policy.ts";
import { checkTexts } from "./check.ts";
import type { Finding } from "./check.ts";
import { catalogTexts, messageTexts } from "./extract.ts";
import type { SourceText } from "./extract.ts";
import { Morphemes } from "./morphemes.ts";

/** Some wording breaks the rules; the findings are already printed. */
class WordingViolations extends Schema.TaggedError<WordingViolations>()("WordingViolations", {
  count: Schema.Int,
}) {
  override get message() {
    return `문구 규칙 위반 ${this.count}건`;
  }
}

/** Kiwi with what it needs to fetch and verify its model on first use. */
const morphemes = Morphemes.layer.pipe(
  Layer.provide([FetchHttpClient.layer, Digest.layerWebCrypto]),
);

/** Whether the policy covers `file` (a path from the repository root) at all. */
const covered = (file: string) =>
  /\.tsx?$/.test(file) &&
  wordingScope.some((glob) => matchesGlob(file, glob)) &&
  !wordingExempt.includes(file) &&
  !promptFile.test(file) &&
  !testFile.test(file);

/** The wording in one covered file: a catalog's strings, or the Lingui messages of any other. */
const textsOf = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(file);
  if (catalogFile.test(file)) return yield* catalogTexts(file, source);
  if (linguiMacroModules.some((module) => source.includes(module))) {
    return yield* messageTexts(file, source);
  }
  return Arr.empty<SourceText>();
});

/**
 * Findings in `files`. Kiwi loads only when some file holds wording: it takes about two seconds and
 * 900 MB, and most commits and edits touch none.
 */
const findingsOf = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const relative = Arr.filter(
    Arr.map(files, (file) => path.relative(path.resolve("."), path.resolve(file))),
    covered,
  );
  const read = yield* Effect.forEach(relative, (file) =>
    Effect.map(textsOf(file), (texts) => ({ file, texts })),
  );
  const withWording = Arr.filter(read, ({ texts }) => Arr.isReadonlyArrayNonEmpty(texts));
  if (Arr.isReadonlyArrayEmpty(withWording)) return Arr.empty<Finding>();
  const nested = yield* Effect.forEach(withWording, ({ file, texts }) =>
    checkTexts(file, texts),
  ).pipe(Effect.provide(morphemes));
  return Arr.flatten(nested);
});

const formatFinding = ({ file, line, column, rule, message }: Finding) =>
  `${file}:${line}:${column} [${rule}] ${message}`;

const check = Command.make(
  "check",
  {
    files: Argument.String("file").pipe(
      Argument.withDescription("검사할 파일 (정책 범위 밖이거나 문구가 없는 파일은 건너뜀)"),
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
).pipe(Command.withDescription("Lingui 메시지와 copy.ts 문구를 검사"));

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
