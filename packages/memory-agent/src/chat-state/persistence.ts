import type { ModelMessage, TokenUsage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineInterruptStore,
  defineMessageStore,
  defineMetadataStore,
  defineRunStore,
  type ChatPersistence,
  type InterruptRecord,
  type MessagePage,
  type RunRecord,
} from "@tanstack/ai-persistence";
import { Clock, Effect, MutableHashSet, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { runNativeEffectWith } from "../runtime/native-effect.ts";
import {
  historyProjection,
  type HistoryProjection,
  type MaybeHistoryProjection,
} from "./history-projection-native.ts";
type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };

const RunRow = Schema.Struct({
  run_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.Literals(["running", "interrupted", "completed", "failed", "aborted"]),
  started_at: Schema.Finite,
  finished_at: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(Schema.String),
  sandbox_key: Schema.NullOr(Schema.String),
  detached_since: Schema.NullOr(Schema.Finite),
  cancel_requested: Schema.NullOr(Schema.Literals([0, 1])),
  driver_epoch: Schema.NullOr(Schema.Finite),
});

const InterruptRow = Schema.Struct({
  interrupt_id: Schema.String,
  run_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.Literals(["pending", "resolved", "cancelled"]),
  requested_at: Schema.Finite,
  resolved_at: Schema.NullOr(Schema.Finite),
  payload: Schema.String,
  response: Schema.NullOr(Schema.String),
});
const JsonText = Schema.Struct({ value: Schema.String });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A store call the TanStack persistence contract refuses. */
export class ChatStoreRejected extends Schema.TaggedError<ChatStoreRejected>()(
  "ChatStoreRejected",
  {
    reason: Schema.Literals([
      "duplicate-interrupt",
      "missing-interrupt",
      "interrupt-not-pending",
      "empty-metadata",
    ]),
    id: Schema.String,
  },
) {}

// Stored JSON was written by these stores from the same TanStack types, so parsing restores them.
const parseMessages = (text: string): ModelMessage[] => JSON.parse(text);
const parseUsage = (text: string): TokenUsage => JSON.parse(text);
const parsePayload = (text: string): Record<string, Json> => JSON.parse(text);
const parseValue = (text: string): Json => JSON.parse(text);

/** A session's transcript rebuilt from its durable evidence, for a session with no chat thread. */
type FallbackThread<E> = (threadId: string) => Effect.Effect<ModelMessage[], E>;

const MissingThread = Schema.Struct({ id: Schema.String });
const NewThread = Schema.Struct({
  threadId: Schema.String,
  messages: Schema.fromJsonString(Schema.Array(Schema.Unknown)),
  updatedAt: Schema.Finite,
});

/**
 * Materializes sessions created before TanStack chat persistence existed. Existing chat threads
 * are authoritative and are never overwritten. The session id remains the thread id, so titles,
 * memory nodes, attachments and URLs keep pointing at the same conversation after the provider
 * runtime migration.
 */
export const migrateLegacyChatThreads = Effect.fn("ChatPersistence.migrateLegacyChatThreads")(
  function* <E>(fallbackThread: FallbackThread<E>) {
    const sql = yield* SqlClient.SqlClient;
    const missing = SqlSchema.findAll({
      Request: Schema.Void,
      Result: MissingThread,
      execute: () => sql`
        SELECT sessions.id FROM sessions
        LEFT JOIN chat_threads ON chat_threads.thread_id = sessions.id
        WHERE chat_threads.thread_id IS NULL
        ORDER BY sessions.created_at, sessions.id`,
    });
    const insert = SqlSchema.void({
      Request: NewThread,
      execute: (thread) => sql`
        INSERT INTO chat_threads (thread_id, messages, updated_at)
        VALUES (${thread.threadId}, ${thread.messages}, ${thread.updatedAt})`,
    });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* missing();
        const updatedAt = yield* Clock.currentTimeMillis;
        // Sessions are rebuilt one after another: each reads its own nodes and attachments.
        yield* Effect.forEach(rows, ({ id }) =>
          Effect.flatMap(fallbackThread(id), (messages) =>
            insert({ threadId: id, messages, updatedAt }),
          ),
        );
        return rows.length;
      }),
    );
  },
);

/** Materializes a session imported after the chat-state service started, if still missing. */
export const migrateMissingChatThread = Effect.fn("ChatPersistence.migrateMissingChatThread")(
  function* <E>(threadId: string, fallbackThread: FallbackThread<E>) {
    const sql = yield* SqlClient.SqlClient;
    const missing = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: MissingThread,
      execute: (id) => sql`
        SELECT sessions.id FROM sessions
        LEFT JOIN chat_threads ON chat_threads.thread_id = sessions.id
        WHERE sessions.id = ${id} AND chat_threads.thread_id IS NULL`,
    });
    const insert = SqlSchema.void({
      Request: NewThread,
      execute: (thread) => sql`
        INSERT OR IGNORE INTO chat_threads (thread_id, messages, updated_at)
        VALUES (${thread.threadId}, ${thread.messages}, ${thread.updatedAt})`,
    });
    const row = yield* missing(threadId);
    if (Option.isNone(row)) return false;
    yield* insert({
      threadId: row.value.id,
      messages: yield* fallbackThread(row.value.id),
      updatedAt: yield* Clock.currentTimeMillis,
    });
    return true;
  },
);

/** Optional record fields are left off, not set to undefined, when their column is NULL. */
function toRun(run: typeof RunRow.Type): RunRecord {
  const record: RunRecord = {
    runId: run.run_id,
    threadId: run.thread_id,
    status: run.status,
    startedAt: run.started_at,
  };
  if (run.finished_at !== null) record.finishedAt = run.finished_at;
  if (run.error !== null) {
    record.error = { message: run.error };
    if (run.error_code !== null) record.error.code = run.error_code;
  }
  if (run.usage !== null) record.usage = parseUsage(run.usage);
  if (run.sandbox_key !== null) record.sandboxKey = run.sandbox_key;
  if (run.detached_since !== null) record.detachedSince = run.detached_since;
  if (run.cancel_requested !== null) record.cancelRequested = run.cancel_requested === 1;
  if (run.driver_epoch !== null) record.driverEpoch = run.driver_epoch;
  return record;
}

function toInterrupt(interrupt: typeof InterruptRow.Type): InterruptRecord {
  const record: InterruptRecord = {
    interruptId: interrupt.interrupt_id,
    runId: interrupt.run_id,
    threadId: interrupt.thread_id,
    status: interrupt.status,
    requestedAt: interrupt.requested_at,
    payload: parsePayload(interrupt.payload),
  };
  if (interrupt.resolved_at !== null) record.resolvedAt = interrupt.resolved_at;
  if (interrupt.response !== null) record.response = parseValue(interrupt.response);
  return record;
}

/** Session status needs the newest run, not the complete run history. */
export const latestChatRun = Effect.fn("ChatPersistence.latestChatRun")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const latest = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RunRow,
    execute: (threadId) =>
      sql`SELECT * FROM chat_runs WHERE thread_id = ${threadId} ORDER BY started_at DESC, run_id DESC LIMIT 1`,
  });
  return (threadId: string) =>
    Effect.map(latest(threadId), Option.match({ onNone: () => null, onSome: toRun }));
});

/**
 * TanStack AI chat persistence on the app's SqlClient: the four state stores with the contract's
 * invariants (full-replace threads, insert-if-absent runs and interrupts, NULL clears for
 * durable-run fields, ordered listings). Legacy transcripts are materialized by
 * `migrateLegacyChatThreads` before this store is constructed; a missing row is therefore a new
 * thread and must be empty. Rebuilding it dynamically from nodes would include the user node that
 * `AgentChat` records immediately before a first run and duplicate that incoming message.
 */
export const chatPersistence: Effect.Effect<ChatPersistence, never, SqlClient.SqlClient> =
  Effect.suspend(() => makeChatPersistence(Option.none()));

/** Production factory: page reads come from the history projection kept beside each save. */
export const ownedChatPersistence = Effect.gen(function* () {
  const projection = yield* historyProjection(parseMessages);
  yield* projection.prepare();
  return {
    ...(yield* makeChatPersistence(Option.some(projection))),
    prepareThread: (threadId: string) => projection.prepare(threadId),
  };
});

const makeChatPersistence = Effect.fn("ChatPersistence.make")(function* (
  projection: MaybeHistoryProjection,
) {
  const sql = yield* SqlClient.SqlClient;
  const run = runNativeEffectWith(yield* Effect.context());

  const selectThread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: JsonText,
    execute: (threadId) =>
      sql`SELECT messages AS value FROM chat_threads WHERE thread_id = ${threadId}`,
  });
  const storedThread = (threadId: string) =>
    Effect.map(
      selectThread(threadId),
      Option.match({ onNone: () => [], onSome: (row) => parseMessages(row.value) }),
    );
  const loadPage = Effect.fnUntraced(function* (
    threadId: string,
    options: { limit: number; before: string | undefined },
    projected: Option.Option<HistoryProjection>,
  ) {
    if (Option.isSome(projected))
      return yield* options.before === undefined
        ? projected.value.load({ type: "initial", threadId, limit: options.limit })
        : projected.value.load({
            type: "older",
            threadId,
            limit: options.limit,
            before: options.before,
          });
    // Old imported transcripts may lack ids. Paging needs a cursor that survives each GET.
    const messages = (yield* storedThread(threadId)).map((message, index) =>
      message.id === undefined ? { ...message, id: `stored:${threadId}:${index}` } : message,
    );
    const before = options.before;
    if (before === undefined) return { messages, truncated: false } satisfies MessagePage;
    const end = messages.findIndex((message) => message.id === before);
    return {
      messages: end < 0 ? [] : messages.slice(0, end),
      truncated: false,
    } satisfies MessagePage;
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string): Promise<ModelMessage[]>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(
    threadId: string,
    options: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string, options?: { limit?: number; before?: string }) {
    const limit = options?.limit;
    if (limit === undefined) return run(storedThread(threadId));
    return run(loadPage(threadId, { limit, before: options?.before }, projection));
  }

  const saveThread = Effect.fn("ChatPersistence.saveThread")(function* (
    threadId: string,
    next: readonly ModelMessage[],
  ) {
    const models = next.filter((message) => !isEmptyUserText(message));
    const sourceJSON = yield* encodeJson(models);
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO chat_threads VALUES (${threadId}, ${sourceJSON}, ${updatedAt})
          ON CONFLICT(thread_id) DO UPDATE
          SET messages = excluded.messages, updated_at = excluded.updated_at`;
        if (Option.isNone(projection)) return;
        yield* projection.value.replace({ threadId, sourceJSON, models }).pipe(
          Effect.catchTag("HistoryPageUnavailable", (failure) => {
            switch (failure.reason) {
              // Valid original records must survive a UI-only ID collision; readiness remains
              // stale and reads fail explicitly.
              case "id-collision":
                return Effect.void;
              case "not-ready":
              case "invalid-transcript":
                return Effect.fail(failure);
            }
          }),
        );
      }),
    );
  });

  const messages = defineMessageStore({
    loadThread,
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    saveThread: (threadId, next) => run(saveThread(threadId, next)),
  });

  const runById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RunRow,
    execute: (runId) => sql`SELECT * FROM chat_runs WHERE run_id = ${runId}`,
  });
  const storedRun = SqlSchema.findOne({
    Request: Schema.String,
    Result: RunRow,
    execute: (runId) => sql`SELECT * FROM chat_runs WHERE run_id = ${runId}`,
  });
  const activeRun = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RunRow,
    execute: (threadId) =>
      sql`SELECT * FROM chat_runs WHERE thread_id = ${threadId} AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
  });
  const threadRuns = SqlSchema.findAll({
    Request: Schema.String,
    Result: RunRow,
    execute: (threadId) =>
      sql`SELECT * FROM chat_runs WHERE thread_id = ${threadId} ORDER BY started_at, run_id`,
  });
  const reclaimableRuns = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: RunRow,
    execute: (detachedBefore) =>
      sql`SELECT * FROM chat_runs WHERE status = 'running' AND detached_since IS NOT NULL AND detached_since <= ${detachedBefore}`,
  });
  const runOrNull = Option.match({ onNone: () => null, onSome: toRun });

  const updateRun = Effect.fn("ChatPersistence.updateRun")(function* (
    runId: string,
    patch: Partial<RunRecord>,
  ) {
    const columns: Record<string, string | number | null> = {};
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.finishedAt !== undefined) columns.finished_at = patch.finishedAt;
    if (patch.error !== undefined) {
      columns.error = patch.error.message;
      columns.error_code = patch.error.code ?? null;
    }
    if (patch.usage !== undefined) columns.usage = yield* encodeJson(patch.usage);
    // Durable-run fields: an explicit `undefined` clears the column, an absent key leaves it.
    if (Object.hasOwn(patch, "sandboxKey")) columns.sandbox_key = patch.sandboxKey ?? null;
    if (Object.hasOwn(patch, "detachedSince")) columns.detached_since = patch.detachedSince ?? null;
    if (Object.hasOwn(patch, "cancelRequested"))
      columns.cancel_requested =
        patch.cancelRequested === undefined ? null : patch.cancelRequested ? 1 : 0;
    if (Object.hasOwn(patch, "driverEpoch")) columns.driver_epoch = patch.driverEpoch ?? null;
    if (Object.keys(columns).length === 0) return;
    yield* sql`UPDATE chat_runs SET ${sql.update(columns)} WHERE run_id = ${runId}`;
  });

  const runs = defineRunStore({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    createOrResume: ({ runId, threadId, startedAt, status }) =>
      run(
        sql
          .withTransaction(
            Effect.andThen(
              sql`
                INSERT INTO chat_runs (run_id, thread_id, status, started_at)
                VALUES (${runId}, ${threadId}, ${status ?? "running"}, ${startedAt})
                ON CONFLICT(run_id) DO NOTHING`,
              storedRun(runId),
            ),
          )
          .pipe(Effect.map(toRun)),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    update: (runId, patch) => run(updateRun(runId, patch)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    get: (runId) => run(Effect.map(runById(runId), runOrNull)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    findActiveRun: (threadId) => run(Effect.map(activeRun(threadId), runOrNull)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    listByThread: (threadId) => run(Effect.map(threadRuns(threadId), (rows) => rows.map(toRun))),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    listReclaimable: ({ now, ttlMs }) =>
      run(Effect.map(reclaimableRuns(now - ttlMs), (rows) => rows.map(toRun))),
  });

  const interruptById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: InterruptRow,
    execute: (interruptId) =>
      sql`SELECT * FROM chat_interrupts WHERE interrupt_id = ${interruptId}`,
  });
  const listed = (where: "thread" | "thread-pending" | "run" | "run-pending", value: string) => {
    const filter = (() => {
      switch (where) {
        case "thread":
          return sql`thread_id = ${value}`;
        case "thread-pending":
          return sql`thread_id = ${value} AND status = 'pending'`;
        case "run":
          return sql`run_id = ${value}`;
        case "run-pending":
          return sql`run_id = ${value} AND status = 'pending'`;
      }
    })();
    return SqlSchema.findAll({
      Request: Schema.Void,
      Result: InterruptRow,
      execute: () => sql`SELECT * FROM chat_interrupts WHERE ${filter} ORDER BY requested_at, seq`,
    })().pipe(Effect.map((rows) => rows.map(toInterrupt)));
  };
  // `undefined` has no JSON form: the column stays NULL, which reads back as "no response".
  const responseJson = (response: InterruptRecord["response"]) =>
    response === undefined ? Effect.succeed(null) : encodeJson(response);
  const resolveInterrupt = (interruptId: string, resolvedAt: number, response: string | null) =>
    sql`UPDATE chat_interrupts SET status = 'resolved', resolved_at = ${resolvedAt}, response = ${response} WHERE interrupt_id = ${interruptId}`;
  const cancelInterrupt = (interruptId: string, resolvedAt: number) =>
    sql`UPDATE chat_interrupts SET status = 'cancelled', resolved_at = ${resolvedAt} WHERE interrupt_id = ${interruptId}`;

  const commitBatch = Effect.fn("ChatPersistence.commitInterrupts")(function* (
    entries: ReadonlyArray<{
      readonly interruptId: string;
      readonly status: "resolved" | "cancelled";
      readonly response?: unknown;
    }>,
  ) {
    const ids = MutableHashSet.empty<string>();
    for (const entry of entries) {
      if (MutableHashSet.has(ids, entry.interruptId))
        return yield* ChatStoreRejected.make({
          reason: "duplicate-interrupt",
          id: entry.interruptId,
        });
      MutableHashSet.add(ids, entry.interruptId);
      const row = yield* interruptById(entry.interruptId);
      if (Option.isNone(row))
        return yield* ChatStoreRejected.make({
          reason: "missing-interrupt",
          id: entry.interruptId,
        });
      if (row.value.status !== "pending")
        return yield* ChatStoreRejected.make({
          reason: "interrupt-not-pending",
          id: entry.interruptId,
        });
    }
    const resolvedAt = yield* Clock.currentTimeMillis;
    for (const entry of entries) {
      switch (entry.status) {
        case "resolved":
          yield* resolveInterrupt(
            entry.interruptId,
            resolvedAt,
            yield* responseJson(entry.response),
          );
          break;
        case "cancelled":
          yield* cancelInterrupt(entry.interruptId, resolvedAt);
          break;
      }
    }
  });

  const interrupts = defineInterruptStore({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    create: (record) =>
      run(
        Effect.flatMap(
          encodeJson(record.payload),
          (payload) => sql`
            INSERT INTO chat_interrupts (interrupt_id, run_id, thread_id, status, requested_at, payload)
            VALUES (${record.interruptId}, ${record.runId}, ${record.threadId}, 'pending', ${record.requestedAt}, ${payload})
            ON CONFLICT(interrupt_id) DO NOTHING`,
        ).pipe(Effect.asVoid),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    resolve: (interruptId, response) =>
      run(
        Effect.gen(function* () {
          yield* resolveInterrupt(
            interruptId,
            yield* Clock.currentTimeMillis,
            yield* responseJson(response),
          );
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    cancel: (interruptId) =>
      run(
        Effect.asVoid(
          Effect.flatMap(Clock.currentTimeMillis, (now) => cancelInterrupt(interruptId, now)),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    commitBatch: (entries) => run(sql.withTransaction(commitBatch(entries))),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    get: (interruptId) =>
      run(
        Effect.map(
          interruptById(interruptId),
          Option.match({ onNone: () => null, onSome: toInterrupt }),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    list: (threadId) => run(listed("thread", threadId)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    listPending: (threadId) => run(listed("thread-pending", threadId)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    listByRun: (runId) => run(listed("run", runId)),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    listPendingByRun: (runId) => run(listed("run-pending", runId)),
  });

  const metadataValue = SqlSchema.findOneOption({
    Request: Schema.Struct({ namespace: Schema.String, key: Schema.String }),
    Result: JsonText,
    execute: ({ namespace, key }) =>
      sql`SELECT value FROM chat_metadata WHERE namespace = ${namespace} AND key = ${key}`,
  });
  const metadata = defineMetadataStore({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    get: (namespace, key) =>
      run(
        Effect.map(
          metadataValue({ namespace, key }),
          Option.match({ onNone: () => null, onSome: (row) => parseValue(row.value) }),
        ),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    set: (namespace, key, value) =>
      run(
        Effect.gen(function* () {
          if (value === null || value === undefined)
            return yield* ChatStoreRejected.make({ reason: "empty-metadata", id: key });
          yield* sql`
            INSERT INTO chat_metadata VALUES (${namespace}, ${key}, ${yield* encodeJson(value)})
            ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`;
        }),
      ),
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    delete: (namespace, key) =>
      run(
        Effect.asVoid(
          sql`DELETE FROM chat_metadata WHERE namespace = ${namespace} AND key = ${key}`,
        ),
      ),
  });

  return defineAIPersistence({ stores: { messages, runs, interrupts, metadata } });
});
