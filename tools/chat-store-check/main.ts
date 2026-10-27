// Checks the TanStack chat-row migration on copies of the local database before it ships
// (docs/effect-ai-migration.md, steps 1 and 2): the rows, and the requests the Effect AI model
// builds from them. The copies hold the user's conversations: they stay outside the repository,
// and the report holds counts, ids, Schema paths and JSON paths, never row content.
// Submodules only: the package entry also loads NodeRedis and its client.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DatabaseSync } from "node:sqlite";
import {
  Clock,
  Console,
  Effect,
  Exit,
  FileSystem,
  MutableHashMap,
  Option,
  Path,
  Predicate,
  Schema,
  SchemaIssue,
} from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  fingerprint,
  HandoffState,
  legacyFingerprint,
  modelHandoffNamespace,
  type SavedHandoff,
} from "../../packages/memory-agent/src/agent/handoff-state.ts";
import {
  StoredHistoryGroup,
  StoredInterruptPayload,
  StoredInterruptResponse,
  StoredMessage,
  StoredUsage,
} from "../../packages/memory-agent/src/chat-store/schema.ts";
import { migrateTanStackRows } from "../../packages/memory-agent/src/chat-store/tanstack-migration.ts";
import { migrationClient } from "../../packages/memory-agent/src/db/migration-client.ts";
import type { JsonValue } from "../../packages/memory-agent/src/json.ts";
import { fromPrompt, toPrompt } from "../../packages/memory-agent/src/model/prompt.ts";
import { historyScreen } from "../../packages/memory-agent/tests/support/history-screen.ts";
import {
  asTanStack,
  next,
  parseTanStackMessages,
  requestDifferences,
  system,
} from "../../packages/memory-agent/tests/support/requests.ts";

class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type JsonObject = { readonly [key: string]: JsonValue };
type Entries = ReadonlyArray<readonly [string, JsonValue]>;
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);
// SQLite holds these texts as the stores wrote them from JSON values.
const parseJson = (text: string): JsonValue => JSON.parse(text);
const parseArray = (text: string): readonly JsonValue[] => JSON.parse(text);

/** The message fields the migration lifts out of `metadata.tanstack`. */
const liftedFields = ["createdAt", "model", "source", "finishReason", "stopReason"] as const;
const isLifted = Schema.is(Schema.Literals(liftedFields));
const withoutMetadata = (value: JsonValue): JsonValue =>
  isObject(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "metadata"))
    : value;

/**
 * What a message says, wherever TanStack or the migration keeps it: everything but metadata, and
 * the lifted fields from the message or else from TanStack's metadata.
 */
const said = (message: JsonValue | undefined): JsonValue => {
  if (!isObject(message)) return message ?? null;
  const tanstack = isObject(message["metadata"]) ? message["metadata"]["tanstack"] : undefined;
  const held: JsonObject = isObject(tanstack) ? tanstack : {};
  const fields = Object.entries(message).flatMap(([key, value]): Entries => {
    if (key === "metadata" || isLifted(key)) return [];
    return [
      [key, key === "toolCalls" && Array.isArray(value) ? value.map(withoutMetadata) : value],
    ];
  });
  const lifted = liftedFields.flatMap((field): Entries => {
    const from = Object.hasOwn(message, field) ? message : held;
    return Object.hasOwn(from, field) ? [[field, from[field]!]] : [];
  });
  return Object.fromEntries([...fields, ...lifted]);
};

/** The JSON paths where two values differ; never the values, which quote the conversation. */
const differingPaths = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  path: string,
): ReadonlyArray<string> =>
  fingerprint(left) === fingerprint(right)
    ? []
    : isObject(left) && isObject(right)
      ? [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
          differingPaths(left[key], right[key], `${path}.${key}`),
        )
      : Array.isArray(left) && Array.isArray(right)
        ? Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
            differingPaths(left[index], right[index], `${path}.${index}`),
          ).flat()
        : [path];

/**
 * What the page shows of a UI message: everything but the metadata of the message and its parts,
 * which hold TanStack's metadata and which the page never reads.
 */
const shown = (message: JsonValue | undefined): JsonValue | undefined =>
  isObject(message)
    ? Object.fromEntries(
        Object.entries(message).flatMap(([key, value]): Entries => {
          if (key === "metadata") return [];
          return [
            [key, key === "parts" && Array.isArray(value) ? value.map(withoutMetadata) : value],
          ];
        }),
      )
    : message;

/** Where a migrated screen message differs from the original: its JSON paths, indexes left out. */
const screenDifference = (before: JsonValue | undefined, after: JsonValue | undefined) =>
  [...new Set(differingPaths(before, after, "$").map((path) => path.replace(/\.\d+/g, "[]")))]
    .sort()
    .join(" ");

/** Whether a saved handoff still finds its boundary in `messages`, as replay looks for it. */
const anchored = (saved: SavedHandoff, messages: readonly JsonValue[]) => {
  const through =
    saved.anchorId === undefined
      ? saved.through
      : messages.findIndex((message) => isObject(message) && message["id"] === saved.anchorId) + 1;
  const boundary = messages[through - 1];
  const actual = saved.anchor.startsWith("v2:")
    ? fingerprint(boundary)
    : legacyFingerprint(boundary);
  return through > 0 && actual === saved.anchor;
};

const exact = { onExcessProperty: "error" } as const;
const decodeMessage = Schema.decodeUnknownEffect(StoredMessage);
const decodeHistory = Schema.decodeUnknownOption(Schema.Array(StoredMessage));
const decodeGroup = Schema.decodeUnknownEffect(StoredHistoryGroup);
const decodeUsage = Schema.decodeUnknownEffect(StoredUsage);
const decodePayload = Schema.decodeUnknownEffect(StoredInterruptPayload);
const decodeResponse = Schema.decodeUnknownEffect(StoredInterruptResponse);
const decodeHandoff = Schema.decodeUnknownEffect(Schema.fromJsonString(HandoffState));
const issues = SchemaIssue.makeFormatterStandardSchemaV1();
/** Where a value failed its Schema; the messages are left out, as they quote the value. */
const issuePaths = (error: Schema.SchemaError) =>
  [
    ...new Set(
      issues(error.issue).issues.map(
        (issue) =>
          (issue.path ?? [])
            .map((segment) => String(Predicate.isObject(segment) ? segment.key : segment))
            .join(".") || "(root)",
      ),
    ),
  ].join(" | ");

/** Counts of each check, and the first failures of each kind. */
const makeReport = () => {
  const counts = MutableHashMap.empty<string, number>();
  const failures = MutableHashMap.empty<string, string[]>();
  const count = (name: string) =>
    MutableHashMap.set(
      counts,
      name,
      Option.getOrElse(MutableHashMap.get(counts, name), () => 0) + 1,
    );
  const fail = (name: string, where: string) => {
    count(`FAIL ${name}`);
    const kept = Option.getOrElse(MutableHashMap.get(failures, name), () => []);
    MutableHashMap.set(failures, name, kept.length < 10 ? [...kept, where] : kept);
  };
  const decoded = <A, R>(
    name: string,
    where: string,
    decoding: Effect.Effect<A, Schema.SchemaError, R>,
  ) =>
    Effect.match(decoding, {
      onFailure: (error) => fail(name, `${where}: ${issuePaths(error)}`),
      onSuccess: () => count(name),
    });
  const print = Effect.gen(function* () {
    const sorted = <V>(map: MutableHashMap.MutableHashMap<string, V>) =>
      [...map].sort(([left], [right]) => left.localeCompare(right));
    for (const [name, total] of sorted(counts)) yield* Console.log(`${name}: ${total}`);
    for (const [name, where] of sorted(failures)) {
      yield* Console.log(`\n${name}:`);
      for (const line of where) yield* Console.log(`  ${line}`);
    }
  });
  return { count, fail, decoded, print };
};

const open = (file: string, readOnly: boolean) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(file, { readOnly }),
      catch: (cause) => CheckFailed.make({ message: `cannot open ${file}`, cause }),
    }),
    (db) => Effect.sync(() => db.close()),
  );

/** A consistent copy of `from`, write-ahead log included, made through SQLite. */
const copy = (from: string, to: string) =>
  Effect.scoped(
    Effect.flatMap(open(from, true), (db) =>
      Effect.try({
        try: () => db.prepare("VACUUM INTO ?").run(to),
        catch: (cause) => CheckFailed.make({ message: `cannot copy ${from}`, cause }),
      }),
    ),
  );

const ThreadPair = Schema.Struct({ before: Schema.String, after: Schema.String });
const GroupPair = Schema.Struct({
  ordinal: Schema.Int,
  before: Schema.NullOr(Schema.String),
  after: Schema.String,
});
const RunPair = Schema.Struct({
  run_id: Schema.String,
  before: Schema.String,
  after: Schema.String,
  anthropic: Schema.Literals([0, 1]),
  after_fix: Schema.Literals([0, 1]),
});
const InterruptRow = Schema.Struct({
  interrupt_id: Schema.String,
  payload: Schema.String,
  response: Schema.NullOr(Schema.String),
});
const HandoffPair = Schema.Struct({
  key: Schema.String,
  before: Schema.String,
  after: Schema.String,
  before_messages: Schema.String,
  after_messages: Schema.String,
});

/** When 456191fe, which made the Anthropic adapter count cache reads as input, was committed. */
const anthropicInputFix = 1_792_904_536_000;

const check = Effect.fn("chat-store-check")(function* (sql: SqlClient.SqlClient) {
  const report = makeReport();
  const threadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ thread_id: Schema.String }),
    execute: () => sql`SELECT thread_id FROM chat_threads ORDER BY thread_id`,
  });
  const threadPair = SqlSchema.findOne({
    Request: Schema.String,
    Result: ThreadPair,
    execute: (id) => sql`
      SELECT o.messages AS before, m.messages AS after FROM chat_threads m
      JOIN original.chat_threads o USING (thread_id) WHERE m.thread_id = ${id}`,
  });
  const groupPairs = SqlSchema.findAll({
    Request: Schema.String,
    Result: GroupPair,
    execute: (id) => sql`
      SELECT m.ordinal, o.messages AS before, m.messages AS after FROM chat_history_groups m
      LEFT JOIN original.chat_history_groups o USING (thread_id, ordinal)
      WHERE m.thread_id = ${id} ORDER BY m.ordinal`,
  });

  const compareMessages = (
    name: string,
    where: string,
    before: readonly JsonValue[],
    after: readonly JsonValue[],
  ) =>
    after.length !== before.length
      ? report.fail(`${name} count`, where)
      : after.forEach((message, index) =>
          fingerprint(said(message)) === fingerprint(said(before[index]))
            ? report.count(`${name} same`)
            : report.fail(
                `${name} differs`,
                `${where}#${index} ${isObject(message) && Predicate.isString(message["role"]) ? message["role"] : "?"}`,
              ),
        );

  /** Whether the history page shows the migrated groups as it shows the original ones. */
  const compareScreen = (
    where: string,
    before: ReadonlyArray<JsonValue>,
    after: ReadonlyArray<JsonValue>,
  ) =>
    after.length !== before.length
      ? report.fail("screen message count", where)
      : after.forEach((message, index) =>
          fingerprint(shown(message)) === fingerprint(shown(before[index]))
            ? report.count("screen message same")
            : report.fail(
                `screen message differs at ${screenDifference(shown(before[index]), shown(message))}`,
                `${where}#${index}`,
              ),
        );

  /**
   * Whether the prompt keeps the migrated history, and the Effect AI model sends for it the
   * request TanStack sent for the original. A history that does not decode is reported above.
   */
  const checkReplay = Effect.fnUntraced(function* (
    name: string,
    where: string,
    before: ReturnType<typeof parseTanStackMessages>,
    after: readonly JsonValue[],
  ) {
    const decoded = decodeHistory(after);
    if (Option.isNone(decoded)) return;
    const history = decoded.value;
    if (
      fingerprint(toPrompt(history, [system]).pipe(fromPrompt)) ===
      fingerprint({ system: [system], history })
    )
      report.count(`${name} prompt round trip`);
    else report.fail(`${name} prompt round trip`, where);
    const differences = yield* Effect.exit(
      requestDifferences({
        threadId: where,
        tanstack: [...before, asTanStack(next)],
        stored: [...history, next],
      }),
    );
    if (Exit.isFailure(differences)) return report.fail(`${name} request failed`, where);
    for (const { provider, difference } of differences.value)
      if (difference === undefined) report.count(`${name} request same ${provider}`);
      else report.fail(`${name} request differs ${provider}`, `${where}: ${difference}`);
  });

  yield* Effect.forEach(
    yield* threadIds(),
    Effect.fnUntraced(function* ({ thread_id: id }) {
      const pair = yield* threadPair(id);
      const after = parseArray(pair.after);
      compareMessages("message", id, parseArray(pair.before), after);
      yield* Effect.forEach(
        after,
        (message, index) =>
          report.decoded("message decode", `${id}#${index}`, decodeMessage(message, exact)),
        { discard: true },
      );
      yield* checkReplay("thread", id, parseTanStackMessages(pair.before), after);
      const groups = yield* groupPairs(id);
      yield* Effect.forEach(
        groups,
        (group) => {
          const where = `${id}/${group.ordinal}`;
          const migrated = parseArray(group.after);
          if (group.before === null) report.fail("group missing before", where);
          else compareMessages("group message", where, parseArray(group.before), migrated);
          return report.decoded("group decode", where, decodeGroup(migrated, exact));
        },
        { discard: true },
      );
      // The screen history, group after group, is the longest history the thread had.
      if (groups.length > 0 && groups.every((group) => group.before !== null)) {
        yield* checkReplay(
          "history",
          id,
          groups.flatMap((group) => parseTanStackMessages(group.before ?? "[]")),
          groups.flatMap((group) => parseArray(group.after)),
        );
        compareScreen(
          id,
          historyScreen(groups.map((group) => group.before ?? "[]")),
          historyScreen(groups.map((group) => group.after)),
        );
      }
    }),
    { discard: true },
  );

  const readiness = yield* sql<{ readonly changed: number; readonly ready: number }>`
    SELECT sum(m.ready IS NOT o.ready) AS changed, sum(m.ready) AS ready
    FROM chat_history_projection m JOIN original.chat_history_projection o USING (thread_id)`;
  yield* Console.log(
    `projection ready: ${readiness[0]?.ready ?? 0}, changed: ${readiness[0]?.changed ?? 0}`,
  );

  const runs = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunPair,
    execute: () => sql`
      SELECT m.run_id, o.usage AS before, m.usage AS after,
        m.run_id IN (SELECT run_id FROM api_usage_responses WHERE provider = 'anthropic') AS anthropic,
        m.started_at >= ${anthropicInputFix} AS after_fix
      FROM chat_runs m JOIN original.chat_runs o USING (run_id) WHERE m.usage IS NOT NULL`,
  })();
  yield* Effect.forEach(
    runs,
    (run) => {
      const before = parseJson(run.before);
      const after = parseJson(run.after);
      const read = (value: JsonValue, field: string) =>
        isObject(value) && Predicate.isNumber(value[field]) ? value[field] : undefined;
      const details = isObject(before) ? before["promptTokensDetails"] : undefined;
      const cached = read(details ?? null, "cachedTokens");
      if (run.anthropic === 1)
        report.count(
          `usage anthropic ${run.after_fix === 1 ? "after" : "before"} 456191fe, ${read(details ?? null, "cacheWriteTokens") === undefined ? "no" : "with"} cacheWriteTokens`,
        );
      if (read(after, "inputTokens") !== read(before, "promptTokens"))
        report.count("usage input adjusted");
      if (
        run.anthropic === 0 &&
        cached !== undefined &&
        cached > (read(before, "promptTokens") ?? 0)
      )
        report.fail("usage uncached input left unadjusted", run.run_id);
      if (read(after, "outputTokens") !== read(before, "completionTokens"))
        report.fail("usage output changed", run.run_id);
      const parts =
        (read(after, "cachedInputTokens") ?? 0) + (read(after, "cacheWriteInputTokens") ?? 0);
      if ((read(after, "inputTokens") ?? 0) < parts)
        report.fail("usage input below its cache parts", run.run_id);
      return report.decoded("usage decode", run.run_id, decodeUsage(after, exact));
    },
    { discard: true },
  );

  const interrupts = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: InterruptRow,
    execute: () => sql`SELECT interrupt_id, payload, response FROM chat_interrupts ORDER BY seq`,
  })();
  yield* Effect.forEach(
    interrupts,
    (row) =>
      Effect.andThen(
        report.decoded(
          "interrupt payload decode",
          row.interrupt_id,
          decodePayload(parseJson(row.payload), exact),
        ),
        row.response === null
          ? Effect.void
          : report.decoded(
              "interrupt response decode",
              row.interrupt_id,
              decodeResponse(parseJson(row.response), exact),
            ),
      ),
    { discard: true },
  );

  const handoffs = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: HandoffPair,
    execute: () => sql`
      SELECT m.key, o.value AS before, m.value AS after,
        ot.messages AS before_messages, mt.messages AS after_messages
      FROM chat_metadata m
      JOIN original.chat_metadata o USING (namespace, key)
      JOIN chat_threads mt ON mt.thread_id = m.key
      JOIN original.chat_threads ot ON ot.thread_id = m.key
      WHERE m.namespace = ${modelHandoffNamespace}`,
  })();
  yield* Effect.forEach(
    handoffs,
    Effect.fnUntraced(function* (row) {
      const before = yield* decodeHandoff(row.before);
      const after = yield* decodeHandoff(row.after);
      if (!HandoffState.guards.handoff(before) || !HandoffState.guards.handoff(after)) {
        report.count(`handoff ${before._tag} -> ${after._tag}`);
        return;
      }
      const was = anchored(before, parseArray(row.before_messages));
      const is = anchored(after, parseArray(row.after_messages));
      const kind = before.anchor.startsWith("v2:") ? "v2" : "legacy";
      if (was && !is) report.fail("handoff anchor lost", row.key);
      else
        report.count(
          `handoff ${kind} ${was ? "anchored" : "unanchored"} -> ${is ? "anchored" : "unanchored"}`,
        );
    }),
    { discard: true },
  );

  yield* report.print;
});

/** Rows the second run of the migration changed; a migrated row must pass through unchanged. */
const changeLog = `
  CREATE TEMP TABLE changed (what TEXT NOT NULL);
  CREATE TEMP TRIGGER changed_threads AFTER UPDATE OF messages ON main.chat_threads
    WHEN OLD.messages IS NOT NEW.messages BEGIN INSERT INTO changed VALUES ('thread'); END;
  CREATE TEMP TRIGGER changed_groups AFTER UPDATE OF messages ON main.chat_history_groups
    WHEN OLD.messages IS NOT NEW.messages BEGIN INSERT INTO changed VALUES ('group'); END;
  CREATE TEMP TRIGGER changed_interrupts AFTER UPDATE OF payload ON main.chat_interrupts
    WHEN OLD.payload IS NOT NEW.payload BEGIN INSERT INTO changed VALUES ('interrupt'); END;
  CREATE TEMP TRIGGER changed_runs AFTER UPDATE OF usage ON main.chat_runs
    WHEN OLD.usage IS NOT NEW.usage BEGIN INSERT INTO changed VALUES ('run'); END;
  CREATE TEMP TRIGGER changed_metadata AFTER UPDATE OF value ON main.chat_metadata
    WHEN OLD.value IS NOT NEW.value BEGIN INSERT INTO changed VALUES ('metadata'); END;
`;

const main = Command.make(
  "chat-store-check",
  {
    source: Flag.String("source").pipe(Flag.withDescription("검사할 agent.db")),
    work: Flag.String("work").pipe(Flag.withDescription("사본 두 개를 둘 저장소 밖 폴더")),
  },
  Effect.fn(function* ({ source, work }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.resolve(work);
    if (!path.relative(path.resolve("."), dir).startsWith(".."))
      return yield* CheckFailed.make({ message: "--work must be outside the repository" });
    yield* fs.makeDirectory(dir, { recursive: true });
    const original = path.join(dir, "original.db");
    const migrated = path.join(dir, "migrated.db");
    yield* Effect.forEach(
      [original, migrated].flatMap((file) => [file, `${file}-wal`, `${file}-shm`]),
      (file) => fs.remove(file, { force: true }),
      { discard: true },
    );
    yield* copy(source, original);
    yield* copy(original, migrated);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* migrationClient(yield* open(migrated, false));
        const migrate = migrateTanStackRows().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const started = yield* Clock.currentTimeMillis;
        yield* migrate;
        yield* Console.log(`migration: ${(yield* Clock.currentTimeMillis) - started}ms`);
        yield* sql.unsafe(changeLog).unprepared;
        yield* migrate;
        const changed = yield* sql<{ readonly what: string; readonly rows: number }>`
          SELECT what, count(*) AS rows FROM changed GROUP BY what`;
        yield* Console.log(
          `second run changed: ${changed.map((row) => `${row.what} ${row.rows}`).join(", ") || "nothing"}`,
        );
        yield* sql`ATTACH DATABASE ${original} AS original`;
        yield* check(sql);
      }),
    );
  }),
).pipe(Command.withDescription("로컬 DB 사본에서 TanStack 채팅 행 migration을 검사"));

main.pipe(
  Command.run({ version: "0.0.0" }),
  // Script entry point: the whole program gets its layer here.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
