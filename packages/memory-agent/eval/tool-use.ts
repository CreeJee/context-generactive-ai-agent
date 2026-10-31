import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Console,
  Context,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { messageText } from "../src/agent/compaction.ts";
import type { StoredMessage } from "../src/chat-store/schema.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { memoryAgentLayer } from "../src/layers.ts";
import { RunStore } from "../src/loop/store.ts";
import { McpServers } from "../src/mcp/servers.ts";
import { Projects } from "../src/projects/projects.ts";
import { AuthConnectionState } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { runNativeEffect } from "../src/runtime/native-effect.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path } from "../src/runtime/synchronous-path.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { inProcessChatApi } from "../src/testing/chat-api.ts";
import { ToolFailureResult } from "../src/tools/failure.ts";
const { dirname, join } = path;

// How the model uses the app's tools, on the model the user selected (copied from their
// config.json; keys stay in the keychain). Each case is a small project, one request and the
// expectations its tool calls and answer must meet. Cases come from failures recorded in real
// conversations. A local model costs nothing to repeat; a subscription model spends its quota.
//
//   node eval/tool-use.ts [case …] [--repeat N]

/** The selected model cannot be asked: no provider is selected or it is not signed in. */
class ModelUnavailable extends Schema.TaggedError<
  ModelUnavailable,
  { readonly brand: unique symbol }
>()("ModelUnavailable", { reason: Schema.String }) {}

/** One tool call of the conversation, and the error code it failed with. */
interface Call {
  readonly name: string;
  readonly arguments: string;
  readonly failure: Option.Option<string>;
}

/** What a case's run left: its calls in order, the assistant's text, and the project's files. */
interface Outcome {
  readonly calls: ReadonlyArray<Call>;
  readonly answer: string;
  readonly file: (relative: string) => Effect.Effect<Option.Option<string>>;
}

interface Case {
  readonly name: string;
  /** The recorded failure or relied-on behaviour it checks. */
  readonly why: string;
  readonly files: Readonly<Record<string, string>>;
  /** Symbolic links, by path, to targets relative to the link. */
  readonly links?: Readonly<Record<string, string>>;
  /** Trusts the eval's MCP servers for the project: `tracker` and `code-index`. */
  readonly mcp?: boolean;
  readonly prompt: string;
  /** The expectations the outcome misses; none is a pass. */
  readonly misses: (outcome: Outcome) => Effect.Effect<ReadonlyArray<string>>;
}

/** Calls that failed, except with a code the case expects, such as checking a file exists. */
const failedCalls = ({ calls }: Outcome, expected: ReadonlyArray<string> = []) =>
  calls.flatMap((call) =>
    Option.match(
      Option.filter(call.failure, (code) => !expected.includes(code)),
      {
        onNone: () => [],
        onSome: (code) => [`${call.name} failed: ${code}`],
      },
    ),
  );

const answerHas = (outcome: Outcome, ...expected: ReadonlyArray<RegExp>) =>
  expected.filter((pattern) => !pattern.test(outcome.answer)).map((pattern) => `answer ${pattern}`);

const called = (outcome: Outcome, name: string, argument?: RegExp) =>
  outcome.calls.some(
    (call) => call.name === name && (argument === undefined || argument.test(call.arguments)),
  )
    ? []
    : [`no ${name} call${argument === undefined ? "" : ` with ${argument}`}`];

const searchFixture = [
  'import { tokens } from "./tokens.ts";',
  "",
  "export interface Query {",
  "  readonly text: string;",
  "}",
  "",
  "export const keepTerms = (terms: readonly string[], max: number) => terms.slice(0, max);",
  "",
  "export function plan(query: Query) {",
  "  const all = tokens(query.text);",
  "  return all.length;",
  "}",
  "",
  "export function narrow(query: Query) {",
  "  const all = tokens(query.text);",
  "  const unique = [...new Set(all)];",
  "  const sorted = unique.toSorted();",
  "  const limited = sorted.filter((term) => term.length > 1);",
  "  return keepTerms(limited, 8);",
  "}",
  "",
  "export function wide(query: Query) {",
  "  const all = tokens(query.text);",
  "  const limited = all.filter((term) => term.length > 0);",
  "  const kept = limited.map((term) => term.toLowerCase());",
  "  return keepTerms(kept, 32);",
  "}",
  "",
].join("\n");

const parseFixture = {
  "src/config/parse.ts": [
    "export interface Config {",
    "  readonly port: number;",
    "}",
    "",
    "export function parseConfig(text: string): Config {",
    "  return { port: Number(text.trim()) };",
    "}",
    "",
  ].join("\n"),
  "src/server.ts": [
    'import { parseConfig } from "./config/parse.ts";',
    "",
    "export function startServer(text: string) {",
    "  const config = parseConfig(text);",
    "  return config.port;",
    "}",
    "",
  ].join("\n"),
  "src/cli.ts": [
    'import { parseConfig } from "./config/parse.ts";',
    "",
    "export function main(argv: string[]) {",
    '  return parseConfig(argv[0] ?? "8080");',
    "}",
    "",
  ].join("\n"),
};

const cases: ReadonlyArray<Case> = [
  {
    name: "search-in-one-file",
    why: "search_files was given a file as its directory 17 times (not_directory).",
    files: { "src/search.ts": searchFixture },
    prompt: "src/search.ts 안에서 keepTerms가 나오는 줄 번호를 전부 알려줘.",
    misses: (outcome) =>
      Effect.succeed([...answerHas(outcome, /\b7\b/, /\b19\b/, /\b26\b/), ...failedCalls(outcome)]),
  },
  {
    name: "symlinked-package",
    why: "Reads through pnpm's node_modules links were refused 10 times (symlink).",
    files: {
      "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/README.md":
        "# left-pad\n\nInstall with:\n\n    npm install left-pad --save-exact-7731\n",
    },
    links: { "node_modules/left-pad": ".pnpm/left-pad@1.3.0/node_modules/left-pad" },
    prompt: "node_modules/left-pad/README.md에 적힌 설치 명령을 그대로 알려줘.",
    // The first read meets the link; its refusal names the real path, so the next read is the last.
    misses: (outcome) =>
      Effect.succeed([
        ...answerHas(outcome, /--save-exact-7731/),
        ...failedCalls(outcome, ["symlink"]),
        ...(outcome.calls.length > 3 ? [`${outcome.calls.length} calls`] : []),
      ]),
  },
  {
    name: "lazy-delete",
    why: "Lazy tools were called before discovery 6 times out of 21.",
    files: { "tmp/old.log": "stale\n" },
    prompt: "tmp/old.log 파일 지워줘.",
    misses: (outcome) =>
      Effect.map(outcome.file("tmp/old.log"), (left) => [
        ...(Option.isSome(left) ? ["tmp/old.log still exists"] : []),
        ...failedCalls(outcome),
      ]),
  },
  {
    name: "exact-edit",
    why: "edit_file failed with no_match or changed 21 times.",
    files: {
      "src/config.ts": [
        "export const retries = 3;",
        "export const timeoutSeconds = 30;",
        "export const pageSize = 30;",
        "",
      ].join("\n"),
    },
    prompt: "src/config.ts에서 timeoutSeconds를 60으로 바꿔줘. 다른 값은 그대로 둬.",
    misses: (outcome) =>
      Effect.map(outcome.file("src/config.ts"), (text) => [
        ...(Option.exists(
          text,
          (content) =>
            content ===
            "export const retries = 3;\nexport const timeoutSeconds = 60;\nexport const pageSize = 30;\n",
        )
          ? []
          : ["src/config.ts is not exactly the one change"]),
        ...failedCalls(outcome),
      ]),
  },
  {
    name: "skill-by-description",
    why: "A task that matches a skill's description must read that skill before doing it.",
    files: {
      ".agents/skills/release-notes/SKILL.md": [
        "---",
        'name: "release-notes"',
        'description: "Write release notes for this project. Use whenever the user asks for release notes or a changelog entry."',
        "---",
        "",
        "Write release notes into `docs/RELEASE.md`, newest version first, under a heading",
        "`## v<version>`. Write each change as one line starting with `- fix:` or `- feat:`.",
        "",
      ].join("\n"),
    },
    prompt: "v1.2 릴리즈 노트 써줘. 로그인 버그랑 저장 버그를 고쳤어.",
    misses: (outcome) =>
      Effect.map(outcome.file("docs/RELEASE.md"), (notes) => [
        ...called(outcome, "read_skill", /release-notes/),
        ...(Option.exists(notes, (text) => text.includes("## v1.2") && text.includes("- fix:"))
          ? []
          : ["docs/RELEASE.md has no ## v1.2 with - fix: lines"]),
        // Looking for earlier notes before writing the first ones is fine.
        ...failedCalls(outcome, ["not_found"]),
      ]),
  },
  {
    name: "mcp-issue",
    why: "An MCP tool the task needs is found and called, whether listed in full or by name only.",
    files: {},
    mcp: true,
    prompt: "트래커에서 ENG-42 이슈 담당자가 누구야?",
    misses: (outcome) =>
      Effect.succeed([
        ...called(outcome, "mcp_tracker__get_issue", /ENG-42/),
        ...answerHas(outcome, /박서연/),
        ...failedCalls(outcome),
      ]),
  },
  {
    name: "mcp-search-comment",
    why: "Two MCP tools of one server used in turn: find the issue, then change it.",
    files: {},
    mcp: true,
    prompt: "트래커에서 로그인 타임아웃 이슈를 찾아서 '스테이징에서 재현됨' 댓글을 달아줘.",
    misses: (outcome) =>
      Effect.succeed([
        ...called(outcome, "mcp_tracker__search_issues"),
        ...called(outcome, "mcp_tracker__add_comment", /ENG-42[\s\S]*재현|재현[\s\S]*ENG-42/),
        ...failedCalls(outcome),
      ]),
  },
  {
    name: "mcp-guided",
    why: "codegraph was called 2,235 times because its server guide asks for it before the file tools.",
    files: parseFixture,
    mcp: true,
    prompt: "parseConfig를 호출하는 곳을 알려줘.",
    misses: (outcome) =>
      Effect.succeed([
        ...called(outcome, "mcp_code-index__explore"),
        ...answerHas(outcome, /server\.ts/, /cli\.ts/),
        ...failedCalls(outcome),
      ]),
  },
];

const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(ToolFailureResult));

/** The code a tool result failed with: a tool's own error, or the loop's refusal of the call. */
const failureOf = (content: string) =>
  content.startsWith("Error:")
    ? Option.some(content.slice(0, 80))
    : Option.map(decodeFailure(content), (failure) => failure.error);

/** The conversation's calls in order, each with its result's failure. */
const callsOf = (messages: ReadonlyArray<StoredMessage>): ReadonlyArray<Call> => {
  const results = new Map(
    messages.flatMap((message) =>
      message.role === "tool" ? [[message.toolCallId, messageText(message)] as const] : [],
    ),
  );
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).map((call) => ({
          name: call.function.name,
          arguments: call.function.arguments,
          failure: Option.flatMap(Option.fromNullishOr(results.get(call.id)), failureOf),
        }))
      : [],
  );
};

const Busy = Schema.Struct({ busy: Schema.Finite });
/** Until the session's children, runs and follow-ups are over. */
const settled = (sessionId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT
        (SELECT count(*) FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
         WHERE t.origin_session_id = ${sessionId}
           AND a.status IN ('queued', 'running', 'waiting', 'blocked'))
        + (SELECT count(*) FROM chat_runs WHERE thread_id = ${sessionId} AND status = 'running')
        + (SELECT count(*) FROM parent_notifications n
           WHERE n.origin_session_id = ${sessionId} AND NOT EXISTS (
             SELECT 1 FROM chat_runs r
             WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running')) AS busy`.pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Busy)(rows[0])),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), while: ({ busy }) => busy > 0 }),
    ),
  );

const argument = (flag: string) =>
  Option.flatMap(
    Option.liftPredicate(process.argv.indexOf(flag), (index) => index >= 0),
    (index) => Option.fromNullishOr(process.argv[index + 1]),
  );
const repeat = Option.match(argument("--repeat"), { onNone: () => 1, onSome: Number });
const named = process.argv
  .slice(2)
  .filter((word, index, words) => !word.startsWith("--") && words[index - 1] !== "--repeat");
const chosen = named.length === 0 ? cases : cases.filter((each) => named.includes(each.name));

const evaluate = Effect.fn("eval.toolUse")(function* () {
  const platform = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(platform, FileSystem.FileSystem);
  const crypto = Context.get(platform, Crypto.Crypto);
  const paths = Context.get(platform, Path.Path);
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-tool-use-" });
  const storage = join(base, "storage");
  const home = join(base, "home");
  yield* fs.makeDirectory(storage, { recursive: true });
  yield* fs.makeDirectory(home);
  // The user's model selection and compatible accounts; nothing is written back.
  yield* fs.copyFile(join(yield* defaultStorageRoot, "config.json"), join(storage, "config.json"));
  const server = yield* paths.fromFileUrl(new URL("./tool-use-mcp-server.ts", import.meta.url));
  const entry = (role: string) => ({
    command: process.execPath,
    args: ["--no-warnings", server, role],
  });
  yield* fs.writeFileString(
    join(storage, "mcp.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      mcpServers: { tracker: entry("tracker"), "code-index": entry("code-index") },
    }),
  );
  const services = yield* Layer.build(
    memoryAgentLayer(storage, {
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      skillsHome: home,
    }),
  );
  return yield* Effect.provideContext(
    Effect.gen(function* () {
      const settings = yield* (yield* GlobalConfig).read;
      const providerId = yield* Effect.fromNullishOr(settings.provider).pipe(
        Effect.mapError(() => ModelUnavailable.make({ reason: "no provider selected" })),
      );
      const selection = { provider: providerId, model: settings.model };
      const provider = yield* (yield* ProviderRegistry).get(providerId);
      if (!AuthConnectionState.$is("signed-in")(yield* provider.auth.status))
        return yield* ModelUnavailable.make({ reason: `${providerId} is not signed in` });
      const projects = yield* Projects;
      const chat = yield* inProcessChatApi;
      const runStore = yield* RunStore;
      const attempts = chosen.flatMap((each) =>
        Arr.makeBy(repeat, (attempt) => ({ each, attempt })),
      );
      const results = yield* Effect.forEach(attempts, ({ each, attempt }) =>
        Effect.gen(function* () {
          const root = join(base, `${each.name}-${attempt}`);
          yield* fs.makeDirectory(root);
          yield* Effect.forEach(Object.entries(each.files), ([relative, text]) =>
            Effect.andThen(
              fs.makeDirectory(dirname(join(root, relative)), { recursive: true }),
              fs.writeFileString(join(root, relative), text),
            ),
          );
          yield* Effect.forEach(Object.entries(each.links ?? {}), ([relative, target]) =>
            Effect.andThen(
              fs.makeDirectory(dirname(join(root, relative)), { recursive: true }),
              fs.symlink(target, join(root, relative)),
            ),
          );
          const added = yield* projects.add(root);
          const project = yield* projects.setPermissionMode(added.id, "full");
          const mcp = yield* McpServers;
          yield* Effect.when(
            Effect.forEach(["tracker", "code-index"], (name) =>
              mcp.setTrusted(project, "global", name, true),
            ),
            Effect.succeed(each.mcp === true),
          );
          const session = yield* (yield* Sessions).create(project.id);
          const started = DateTime.toEpochMillis(yield* DateTime.now);
          const finished = yield* chat
            .run({
              params: { session: session.id },
              headers: {},
              payload: {
                runId: yield* crypto.randomUUIDv4(),
                messages: [
                  { id: yield* crypto.randomUUIDv4(), role: "user", content: each.prompt },
                ],
              },
            })
            .pipe(
              Effect.flatMap(Stream.runDrain),
              Effect.andThen(settled(session.id)),
              Effect.timeoutOption("5 minutes"),
            );
          const messages = yield* runStore.thread(session.id);
          const outcome: Outcome = {
            calls: callsOf(messages),
            answer: messages
              .filter((message) => message.role === "assistant")
              .map(messageText)
              .join("\n"),
            file: (relative) =>
              fs
                .readFileString(join(root, relative))
                .pipe(Effect.option, Effect.provideContext(platform)),
          };
          const misses = [
            ...(Option.isNone(finished) ? ["timed out after 5 minutes"] : []),
            ...(yield* each.misses(outcome)),
          ];
          return {
            case: each.name,
            attempt,
            passed: misses.length === 0,
            misses,
            calls: outcome.calls.map((call) =>
              Option.match(call.failure, {
                onNone: () => call.name,
                onSome: (code) => `${call.name} (${code})`,
              }),
            ),
            seconds: Math.round((DateTime.toEpochMillis(yield* DateTime.now) - started) / 1000),
          };
        }),
      );
      return {
        selection,
        results,
        summary: chosen.map((each) => {
          const runs = results.filter((result) => result.case === each.name);
          return {
            case: each.name,
            why: each.why,
            passed: `${runs.filter((result) => result.passed).length}/${runs.length}`,
          };
        }),
      };
    }),
    services,
  );
}, Effect.scoped);

// Native stdout/stderr or SDK logging boundary preserves the existing output format.
await runNativeEffect(
  Effect.flatMap(evaluate(), (report) => Console.log(JSON.stringify(report, null, 2))),
);
