import {
  Array as Arr,
  Effect,
  Function as EffectFunction,
  Match,
  Option,
  Predicate,
  Schema,
  Struct,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  fingerprint,
  HandoffState,
  legacyFingerprint,
  modelHandoffNamespace,
  type SavedHandoff,
} from "../agent/handoff-state.ts";
import { historyProjectionSchema } from "../chat-state/history-projection-sql.ts";
import type { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * The one migration of the Effect AI switch: the chat rows TanStack wrote move to the shapes of
 * `schema.ts` (step 1 of docs/effect-ai-migration.md). Each transform is idempotent, so a row
 * already migrated passes through unchanged.
 */

type JsonObject = { readonly [key: string]: JsonValue };
type Entries = ReadonlyArray<readonly [string, JsonValue]>;
const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);
const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);
const count = (value: JsonValue | undefined) => (Predicate.isNumber(value) ? value : undefined);

/** `object` with each entry replaced, in place, by the entries `entry` returns for it. */
const replaceEntries = (
  object: JsonObject,
  entry: (key: string, value: JsonValue) => Entries,
): JsonObject =>
  Object.fromEntries(Object.entries(object).flatMap(([key, value]) => entry(key, value)));

/** TanStack's keys in a `metadata` object: `tanstack`, and `tanstack:` ones on interrupts. */
const isTanStackKey = (key: string) => key === "tanstack" || key.startsWith("tanstack:");

/** A `metadata` entry without TanStack's keys, gone when nothing else was in it. */
const metadataEntry = (metadata: JsonValue): Entries =>
  Option.match(Option.liftPredicate(metadata, isJsonObject), {
    onNone: () => [["metadata", metadata]],
    onSome: (object) => {
      const kept = replaceEntries(object, (key, value) =>
        isTanStackKey(key) ? [] : [[key, value]],
      );
      return Object.keys(kept).length === 0 ? [] : [["metadata", kept]];
    },
  });

/**
 * The fields of a message's `metadata.tanstack` the app keeps. Replay reads `source`,
 * `finishReason` and `stopReason`; model handoff reads `model`. `createdAt` repeats the
 * message's own.
 */
const keptFields = ["createdAt", "model", "source", "finishReason", "stopReason"] as const;

/** A tool call without the metadata TanStack gave it, which nothing reads. */
const migrateToolCall = (call: JsonValue): JsonValue =>
  isJsonObject(call)
    ? replaceEntries(call, (key, value) =>
        key === "metadata" ? metadataEntry(value) : [[key, value]],
      )
    : call;

/** A message with its kept TanStack fields lifted to the top level, where its metadata was. */
export const migrateMessage = (message: JsonValue): JsonValue =>
  Option.liftPredicate(message, isJsonObject).pipe(
    Option.map(migrateMessageObject),
    Option.getOrElse(() => message),
  );

const migrateMessageObject = (message: JsonObject): JsonObject => {
  const tanstack = isJsonObject(message.metadata) ? message.metadata.tanstack : undefined;
  const lifted: Entries = isJsonObject(tanstack)
    ? keptFields
        .filter((field) => Object.hasOwn(tanstack, field) && !Object.hasOwn(message, field))
        .map((field) => [field, tanstack[field]])
    : [];
  return replaceEntries(message, (key, value) =>
    Match.value(key).pipe(
      Match.when("metadata", (): Entries => [...lifted, ...metadataEntry(value)]),
      Match.when("toolCalls", (): Entries => [
        [key, isJsonArray(value) ? value.map(migrateToolCall) : value],
      ]),
      Match.orElse((): Entries => [[key, value]]),
    ),
  );
};

/** Stored messages, each migrated; anything else is left as it is. */
const migrateMessages = (messages: JsonValue): JsonValue =>
  isJsonArray(messages) ? messages.map(migrateMessage) : messages;

/**
 * A TanStack `TokenUsage` as AG-UI 1.0's. `inputExcludesCache`: the Anthropic adapter before
 * 456191fe reported only the uncached input, so the cache reads and writes are added back and the
 * total follows.
 */
export const migrateUsage: {
  (inputExcludesCache: boolean): (usage: JsonValue) => JsonValue;
} & typeof migrateUsageBody = EffectFunction.dual(2, migrateUsageBody);
function migrateUsageBody(usage: JsonValue, inputExcludesCache: boolean): JsonValue {
  return Option.liftPredicate(usage, isJsonObject).pipe(
    Option.flatMap((object) =>
      Option.map(Option.liftPredicate(object.promptTokens, Predicate.isNumber), (promptTokens) =>
        agUiUsage({ usage: object, promptTokens, inputExcludesCache }),
      ),
    ),
    Option.getOrElse(() => usage),
  );
}

/** A TanStack usage that reported its input tokens. */
function agUiUsage({
  usage,
  promptTokens,
  inputExcludesCache,
}: {
  readonly usage: JsonObject;
  readonly promptTokens: number;
  readonly inputExcludesCache: boolean;
}) {
  const prompt = isJsonObject(usage.promptTokensDetails) ? usage.promptTokensDetails : {};
  const completion = isJsonObject(usage.completionTokensDetails)
    ? usage.completionTokensDetails
    : {};
  const cached = count(prompt.cachedTokens);
  const written = count(prompt.cacheWriteTokens);
  const output = count(usage.completionTokens);
  const input = inputExcludesCache ? promptTokens + (cached ?? 0) + (written ?? 0) : promptTokens;
  return {
    inputTokens: input,
    ...optionalProperty("outputTokens", output),
    ...optionalProperty(
      "totalTokens",
      inputExcludesCache ? input + (output ?? 0) : count(usage.totalTokens),
    ),
    ...optionalProperty("reasoningTokens", count(completion.reasoningTokens)),
    ...optionalProperty("cachedInputTokens", cached),
    ...optionalProperty("cacheWriteInputTokens", written),
  };
}

/**
 * An interrupt without TanStack's binding. The permission review's request, which TanStack kept
 * as `tanstack:interruptPayload`, becomes `metadata.payload`.
 */
export const migrateInterruptPayload = (payload: JsonValue): JsonValue =>
  isJsonObject(payload) && isJsonObject(payload.metadata)
    ? {
        ...payload,
        metadata: replaceEntries(payload.metadata, (key, value) =>
          Match.value(key).pipe(
            Match.when("tanstack:interruptPayload", (): Entries => [["payload", value]]),
            Match.when("tanstack:interruptBinding", (): Entries => []),
            Match.orElse((): Entries => [[key, value]]),
          ),
        ),
      }
    : payload;

/** Where the handoff's boundary was in the messages before the migration, or -1 if it is gone. */
const boundaryIndex = (saved: SavedHandoff, before: readonly JsonValue[]) =>
  saved.anchor.startsWith("v2:")
    ? v2BoundaryIndex(saved, before)
    : before.findIndex((message) => legacyFingerprint(message) === saved.anchor);

const v2BoundaryIndex = (saved: SavedHandoff, before: readonly JsonValue[]) => {
  const through =
    saved.anchorId === undefined
      ? saved.through
      : before.findIndex((message) => isJsonObject(message) && message.id === saved.anchorId) + 1;
  return through > 0 && fingerprint(before[through - 1]) === saved.anchor ? through - 1 : -1;
};

/**
 * The handoff anchored on the migrated messages: the anchor fingerprints its boundary message,
 * which the migration changes. A legacy anchor moves to v2 as `modelHandoffHistoryEffect` does.
 * A boundary that no longer matched stays as it was; replay refuses it either way.
 */
const migrateHandoff = (
  saved: SavedHandoff,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
): Option.Option<SavedHandoff> => {
  const index = boundaryIndex(saved, before);
  return Option.flatMap(Arr.get(after, index), (boundary) => {
    const anchor = fingerprint(boundary);
    return saved.anchor.startsWith("v2:")
      ? Option.some({ ...saved, anchor }).pipe(Option.filter(() => anchor !== saved.anchor))
      : Option.some({
          ...Struct.omit(saved, ["anchorId"]),
          through: index + 1,
          anchor,
          ...optionalProperty(
            "anchorId",
            isJsonObject(boundary) && Predicate.isString(boundary.id) ? boundary.id : undefined,
          ),
        });
  });
};

// The stores wrote these texts from JSON values, so parsing restores them.
const parseJson = (text: string): JsonValue => JSON.parse(text);
const parseMessages = (text: string): readonly JsonValue[] => JSON.parse(text);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeEffect(Schema.fromJsonString(HandoffState));
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(HandoffState));

const ThreadId = Schema.Struct({ thread_id: Schema.String });
const ThreadRow = Schema.Struct({
  messages: Schema.String,
  ready: Schema.NullOr(Schema.Literals([0, 1])),
});
const BtwThreadRow = Schema.Struct({ id: Schema.String, messages: Schema.String });
const GroupRow = Schema.Struct({ ordinal: Schema.Int, messages: Schema.String });
const ValueRow = Schema.Struct({ value: Schema.String });
const InterruptRow = Schema.Struct({ seq: Schema.Int, payload: Schema.String });
const UsageRow = Schema.Struct({
  run_id: Schema.String,
  usage: Schema.String,
  input_excludes_cache: Schema.Literals([0, 1]),
});

/**
 * Migrates every chat row TanStack wrote: threads, BTW threads, history groups, handoffs,
 * interrupts, usage.
 */
export const migrateTanStackRows = Effect.fn("ChatStore.migrateTanStackRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadId,
    execute: () => sql`SELECT thread_id FROM chat_threads ORDER BY thread_id`,
  });
  const btwThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BtwThreadRow,
    execute: () => sql`SELECT id, messages FROM btw_threads`,
  });
  const thread = SqlSchema.findOne({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (id) => sql`
      SELECT chat_threads.messages, chat_history_projection.ready FROM chat_threads
      LEFT JOIN chat_history_projection USING (thread_id)
      WHERE chat_threads.thread_id = ${id}`,
  });
  const groups = SqlSchema.findAll({
    Request: Schema.String,
    Result: GroupRow,
    execute: (id) => sql`SELECT ordinal, messages FROM chat_history_groups WHERE thread_id = ${id}`,
  });
  const handoff = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ValueRow,
    execute: (id) => sql`
      SELECT value FROM chat_metadata WHERE namespace = ${modelHandoffNamespace} AND key = ${id}`,
  });
  const interrupts = SqlSchema.findAll({
    Request: Schema.Void,
    Result: InterruptRow,
    execute: () => sql`SELECT seq, payload FROM chat_interrupts`,
  });
  // The Anthropic adapter fills `cacheWriteTokens` since 456191fe and never did before it.
  const usages = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UsageRow,
    execute: () => sql`
      SELECT run_id, usage,
        run_id IN (SELECT run_id FROM api_usage_responses WHERE provider = 'anthropic')
          AND json_type(usage, '$.promptTokensDetails.cacheWriteTokens') IS NULL
          AS input_excludes_cache
      FROM chat_runs WHERE usage IS NOT NULL`,
  });
  /**
   * Writes `next` through `write` when it differs from `before`, the value the row held. A row
   * whose text only differs in layout keeps its text.
   */
  const rewrite = <A, E, R>(
    before: JsonValue,
    next: JsonValue,
    write: (text: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.all([encodeJson(before), encodeJson(next)]).pipe(
      Effect.flatMap(([held, encoded]) =>
        write(encoded).pipe(Effect.when(Effect.succeed(encoded !== held))),
      ),
    );
  /** {@link rewrite} of the JSON `text` a row holds, as `migrate` makes it. */
  const rewriteText = <A, E, R>(
    text: string,
    migrate: (value: JsonValue) => JsonValue,
    write: (text: string) => Effect.Effect<A, E, R>,
  ) => {
    const before = parseJson(text);
    return rewrite(before, migrate(before), write);
  };

  const migrateThread = Effect.fnUntraced(function* (id: string) {
    const row = yield* thread(id);
    const before = parseMessages(row.messages);
    const after = before.map(migrateMessage);
    yield* rewrite(
      before,
      after,
      (text) => sql`UPDATE chat_threads SET messages = ${text} WHERE thread_id = ${id}`,
    );
    yield* Effect.forEach(
      yield* groups(id),
      (group) =>
        rewriteText(
          group.messages,
          migrateMessages,
          (text) => sql`
            UPDATE chat_history_groups SET messages = ${text}
            WHERE thread_id = ${id} AND ordinal = ${group.ordinal}`,
        ),
      { discard: true },
    );
    // The thread's update marked its groups stale; they moved with it, so they are as ready as
    // they were. A thread with no projection row has nothing to restore.
    yield* sql`UPDATE chat_history_projection SET ready = ${row.ready} WHERE thread_id = ${id}`;
    const saved = yield* handoff(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (stored) => Effect.option(decodeHandoff(stored.value)),
        }),
      ),
    );
    yield* Option.match(
      saved.pipe(
        Option.filter(HandoffState.guards.handoff),
        Option.flatMap((state) => migrateHandoff(state, before, after)),
      ),
      {
        onNone: () => Effect.void,
        onSome: (state) =>
          encodeHandoff(state).pipe(
            Effect.flatMap(
              (value) => sql`
                UPDATE chat_metadata SET value = ${value}
                WHERE namespace = ${modelHandoffNamespace} AND key = ${id}`,
            ),
          ),
      },
    );
  });

  yield* sql.withTransaction(
    Effect.gen(function* () {
      // The projection's tables, created as the projection creates them, so every thread joins.
      yield* sql.unsafe(historyProjectionSchema).unprepared;
      yield* Effect.forEach(yield* threadIds(), ({ thread_id }) => migrateThread(thread_id), {
        discard: true,
      });
      // A BTW thread has no history groups or handoff, only its messages.
      yield* Effect.forEach(
        yield* btwThreads(),
        (row) =>
          rewriteText(
            row.messages,
            migrateMessages,
            (text) => sql`UPDATE btw_threads SET messages = ${text} WHERE id = ${row.id}`,
          ),
        { discard: true },
      );
      yield* Effect.forEach(
        yield* interrupts(),
        ({ seq, payload }) =>
          rewriteText(
            payload,
            migrateInterruptPayload,
            (text) => sql`UPDATE chat_interrupts SET payload = ${text} WHERE seq = ${seq}`,
          ),
        { discard: true },
      );
      yield* Effect.forEach(
        yield* usages(),
        (run) =>
          rewriteText(
            run.usage,
            migrateUsage(run.input_excludes_cache === 1),
            (text) => sql`UPDATE chat_runs SET usage = ${text} WHERE run_id = ${run.run_id}`,
          ),
        { discard: true },
      );
    }),
  );
});
