// Development tool: checks the copy catalogs (`copy.ts`) for banned phrases, glossary spellings and
// sentence endings. Runs from the commit hook, the Claude Code PostToolUse hook, and by hand.
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

import { checkCopy } from "./check.ts";
import type { Finding } from "./check.ts";
import { extractCopy } from "./extract.ts";
import { Morphemes } from "./morphemes.ts";

/** Copy lives only in files with this name; everything else is checked by the lint rule. */
const catalogFileName = "copy.ts";

/** Some copy breaks the rules; the findings are already printed. */
class CopyViolations extends Schema.TaggedError<CopyViolations>()("CopyViolations", {
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

/**
 * Findings in `files`. Kiwi loads here, not for the whole command: it takes about two seconds and
 * 900 MB, and the hook skips every edit that is not a catalog.
 */
const findingsOf = Effect.fnUntraced(function* (files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nested = yield* Effect.forEach(files, (file) =>
    fs.readFileString(file).pipe(
      Effect.flatMap((source) => extractCopy(file, source)),
      Effect.flatMap((texts) =>
        checkCopy(path.relative(path.resolve("."), path.resolve(file)), texts),
      ),
    ),
  );
  return Arr.flatten(nested);
}, Effect.provide(morphemes));

const formatFinding = ({ file, line, column, rule, message }: Finding) =>
  `${file}:${line}:${column} [${rule}] ${message}`;

const check = Command.make(
  "check",
  {
    files: Argument.String("file").pipe(
      Argument.withDescription("검사할 copy.ts 파일"),
      Argument.atLeast(1),
    ),
  },
  Effect.fn(function* ({ files }) {
    const findings = yield* findingsOf(files);
    yield* Effect.forEach(findings, (finding) => Console.error(formatFinding(finding)), {
      discard: true,
    });
    if (Arr.isReadonlyArrayNonEmpty(findings)) {
      return yield* new CopyViolations({ count: findings.length });
    }
  }),
).pipe(Command.withDescription("copy.ts 파일의 문구를 검사"));

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
    if (file === undefined || !file.endsWith(`/${catalogFileName}`)) return;
    const findings = yield* findingsOf([file]);
    if (Arr.isReadonlyArrayEmpty(findings)) return;
    // PostToolUse: a "block" decision hands the reason back to the agent, which fixes the copy.
    yield* Console.log(
      JSON.stringify({
        decision: "block",
        reason: [
          "UI 문구 규칙 위반이에요. 아래를 고치세요 (규칙: tools/copy-check/rules.ts).",
          ...Arr.map(findings, formatFinding),
        ].join("\n"),
      }),
    );
  }),
).pipe(Command.withDescription("Claude Code PostToolUse hook: 고친 copy.ts만 검사"));

Command.make("copy-check").pipe(
  Command.withSubcommands([check, hook]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
