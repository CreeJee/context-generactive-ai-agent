import { Clock, Context, Data, Effect, HashSet, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { type ChatMetadata, ChatMetadataFailed } from "../chat-store/metadata.ts";
import { interruptContinuationLostCode, type RunStatus } from "../agent/run-state.ts";
import {
  StoredInterruptPayload,
  StoredInterruptResponse,
  StoredMessage,
  StoredRunStatus,
  StoredUsage,
} from "../chat-store/schema.ts";
import { historyProjection } from "../chat-state/history-projection-native.ts";
import { HistoryProjectionReader } from "../chat-state/history-projection-reader.ts";
import { JsonValue } from "../json.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * A run's chat rows on the app's SqlClient (docs/effect-ai-migration.md step 4): the thread, the
 * run record, its interrupts and the chat metadata, in the tables and columns TanStack's
 * persistence used, with the stored shapes of `chat-store/schema.ts`. The history projection is
 * replaced with each saved thread, as before.
 */

const Thread = Schema.fromJsonString(Schema.Array(StoredMessage));
const Usage = Schema.fromJsonString(StoredUsage);
const Payload = Schema.fromJsonString(StoredInterruptPayload);
const Response = Schema.fromJsonString(StoredInterruptResponse);
const Value = Schema.fromJsonString(JsonValue);

/** How a run ended, or that it waits for the user. */
export type RunEnd = Data.TaggedEnum<{
  Completed: {};
  /** Waits for the user; not terminal, so it has no finish time. */
  Interrupted: {};
  Failed: { readonly message: string; readonly code: Option.Option<string> };
  Aborted: {};
}>;
export const RunEnd = Data.taggedEnum<RunEnd>();

/** The run finished or waits for the user, as TanStack's `onFinish` saw it: it neither failed nor was cancelled. */
export const finishedRun = (end: RunEnd) =>
  RunEnd.$is("Completed")(end) || RunEnd.$is("Interrupted")(end);

/** An answer to one pending interrupt, as the resume run commits it. */
export type InterruptAnswer = Data.TaggedEnum<{
  Resolved: {
    readonly interruptId: string;
    readonly response: typeof StoredInterruptResponse.Type;
  };
  Cancelled: { readonly interruptId: string };
}>;
export const InterruptAnswer = Data.taggedEnum<InterruptAnswer>();

export interface PendingInterrupt {
  readonly interruptId: string;
  readonly runId: string;
  readonly payload: StoredInterruptPayload;
}

/** An interrupt batch commit the stored interrupts refuse; nothing of the batch is written. */
export class InterruptCommitRejected extends Schema.TaggedError<
  InterruptCommitRejected,
  { readonly brand: unique symbol }
>()("InterruptCommitRejected", {
  reason: Schema.Literals(["duplicate-interrupt", "missing-interrupt", "interrupt-not-pending"]),
  interruptId: Schema.String,
}) {}

/** A run's record: its thread, how it stands, and why it failed. */
export interface StoredRun {
  readonly runId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly error: { readonly message: string; readonly code?: string } | null;
}

const RunRow = Schema.Struct({
  run_id: Schema.String,
  thread_id: Schema.String,
  status: StoredRunStatus,
  error: Schema.NullOr(Schema.String),
  error_code: Schema.NullOr(Schema.String),
});
const storedRun = (row: typeof RunRow.Type): StoredRun => ({
  runId: row.run_id,
  threadId: row.thread_id,
  status: row.status,
  error:
    row.error === null
      ? null
      : { message: row.error, ...optionalProperty("code", row.error_code ?? undefined) },
});

const RunUsage = Schema.Struct({ usage: Schema.NullOr(Usage) });
const InterruptRow = Schema.Struct({
  interrupt_id: Schema.String,
  run_id: Schema.String,
  payload: Payload,
});
const InterruptStatus = Schema.Struct({
  status: Schema.Literals(["pending", "resolved", "cancelled"]),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* historyProjection();

  const storedThread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ messages: Thread }),
    execute: (threadId) => sql`SELECT messages FROM chat_threads WHERE thread_id = ${threadId}`,
  });

  /**
   * The thread's messages; a thread never saved is empty. `ChatState` writes the threads of
   * sessions recorded before chat state at startup, so a missing thread is a new one: rebuilding
   * it from nodes would repeat the user node `AgentChat` records just before a first run.
   */
  const thread = (threadId: string) =>
    Effect.map(
      storedThread(threadId),
      Option.match({ onNone: () => [], onSome: (row) => row.messages }),
    );

  const threadRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ present: Schema.Literals([0, 1]) }),
    execute: (threadId) =>
      sql`SELECT EXISTS(SELECT 1 FROM chat_threads WHERE thread_id = ${threadId}) AS present`,
  });

  /** Whether the thread was ever saved. */
  const threadSaved = (threadId: string) =>
    Effect.map(threadRow(threadId), ({ present }) => present === 1);

  const runningRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ run_id: Schema.String }),
    execute: (threadId) => sql`
      SELECT run_id FROM chat_runs WHERE thread_id = ${threadId} AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
  });

  /** The thread's run that is still going. */
  const activeRun = (threadId: string) =>
    Effect.map(
      runningRow(threadId),
      Option.map((row) => row.run_id),
    );

  /** A page of the history projection: one group of messages per message the page shows. */
  const history = yield* HistoryProjectionReader;

  /** Replaces the thread and its history groups together. Empty user text is never kept. */
  const saveThread = Effect.fn("RunStore.saveThread")(function* (
    threadId: string,
    messages: ReadonlyArray<StoredMessage>,
  ) {
    const kept = messages.filter((message) => !isEmptyUserText(message));
    const sourceJSON = yield* Schema.encodeEffect(Thread)(kept);
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      sql`
        INSERT INTO chat_threads VALUES (${threadId}, ${sourceJSON}, ${updatedAt})
        ON CONFLICT(thread_id) DO UPDATE
        SET messages = excluded.messages, updated_at = excluded.updated_at`.pipe(
        Effect.andThen(projection.replace({ threadId, sourceJSON, messages: kept })),
        // Valid messages survive a UI-only id collision; reads of the stale pages fail instead.
        Effect.catchTag("HistoryPageUnavailable", (failure) =>
          failure.reason === "id-collision" ? Effect.void : Effect.fail(failure),
        ),
      ),
    );
  });

  const runUsage = SqlSchema.findOne({
    Request: Schema.String,
    Result: RunUsage,
    execute: (runId) => sql`SELECT usage FROM chat_runs WHERE run_id = ${runId}`,
  });

  /** Starts the run, or continues the stored one; gives the usage it already counted. */
  const startRun = Effect.fn("RunStore.startRun")(function* (run: {
    readonly runId: string;
    readonly threadId: string;
  }) {
    const startedAt = yield* Clock.currentTimeMillis;
    const stored = yield* sql.withTransaction(
      sql`
        INSERT INTO chat_runs (run_id, thread_id, status, started_at)
        VALUES (${run.runId}, ${run.threadId}, 'running', ${startedAt})
        ON CONFLICT(run_id) DO NOTHING`.pipe(Effect.andThen(runUsage(run.runId))),
    );
    return Option.fromNullishOr(stored.usage);
  });

  /** Records how the run ended, with the usage it counted. */
  const endRun = Effect.fn("RunStore.endRun")(function* (
    runId: string,
    end: RunEnd,
    usage: Option.Option<StoredUsage>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const finished = { finished_at: now, detached_since: null };
    const columns = RunEnd.$match(end, {
      Completed: () => ({ status: "completed", ...finished }),
      Interrupted: () => ({ status: "interrupted" }),
      Failed: ({ message, code }) => ({
        status: "failed",
        ...finished,
        error: message,
        error_code: Option.getOrNull(code),
      }),
      Aborted: () => ({ status: "aborted", ...finished }),
    });
    const counted = yield* Effect.transposeOption(Option.map(usage, Schema.encodeEffect(Usage)));
    yield* sql`UPDATE chat_runs SET ${sql.update({
      ...columns,
      ...Option.match(counted, { onNone: () => ({}), onSome: (text) => ({ usage: text }) }),
    })} WHERE run_id = ${runId}`;
  });

  const runRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RunRow,
    execute: (runId) => sql`
      SELECT run_id, thread_id, status, error, error_code FROM chat_runs WHERE run_id = ${runId}`,
  });

  /** The run's record. Run ids are unique across threads. */
  const run = (runId: string) => Effect.map(runRow(runId), Option.map(storedRun));

  const lastRunRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RunRow,
    execute: (threadId) => sql`
      SELECT run_id, thread_id, status, error, error_code FROM chat_runs
      WHERE thread_id = ${threadId} ORDER BY started_at DESC, run_id DESC LIMIT 1`,
  });

  /** The thread's newest run. */
  const lastRun = (threadId: string) => Effect.map(lastRunRow(threadId), Option.map(storedRun));

  const pendingRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: InterruptRow,
    execute: (threadId) => sql`
      SELECT interrupt_id, run_id, payload FROM chat_interrupts
      WHERE thread_id = ${threadId} AND status = 'pending'
      ORDER BY requested_at, seq`,
  });

  /** The thread's interrupts that wait for an answer, in the order they were asked. */
  const pendingInterrupts = (threadId: string) =>
    Effect.map(pendingRows(threadId), (rows) =>
      rows.map((row): PendingInterrupt => ({
        interruptId: row.interrupt_id,
        runId: row.run_id,
        payload: row.payload,
      })),
    );

  /** Asks the user: one pending row per interrupt of the run. */
  const createInterrupts = Effect.fn("RunStore.createInterrupts")(function* (
    run: { readonly runId: string; readonly threadId: string },
    interrupts: ReadonlyArray<StoredInterruptPayload>,
  ) {
    const requestedAt = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      interrupts,
      (interrupt) =>
        Effect.flatMap(
          Schema.encodeEffect(Payload)(interrupt),
          (payload) => sql`
            INSERT INTO chat_interrupts (interrupt_id, run_id, thread_id, status, requested_at, payload)
            VALUES (${interrupt.id}, ${run.runId}, ${run.threadId}, 'pending', ${requestedAt}, ${payload})
            ON CONFLICT(interrupt_id) DO NOTHING`,
        ),
      { discard: true },
    );
  });

  const interruptStatus = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: InterruptStatus,
    execute: (interruptId) =>
      sql`SELECT status FROM chat_interrupts WHERE interrupt_id = ${interruptId}`,
  });

  const rejected = (reason: InterruptCommitRejected["reason"], interruptId: string) =>
    InterruptCommitRejected.make({ reason, interruptId });

  /** The interrupt still waits; checked for every answer before any is written. */
  const checkPending = (interruptId: string) =>
    interruptStatus(interruptId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(rejected("missing-interrupt", interruptId)),
          onSome: ({ status }) =>
            Effect.when(
              Effect.fail(rejected("interrupt-not-pending", interruptId)),
              Effect.succeed(status !== "pending"),
            ),
        }),
      ),
    );

  const answered = (resolvedAt: number) =>
    InterruptAnswer.$match({
      Resolved: ({ interruptId, response }) =>
        Effect.flatMap(
          Schema.encodeEffect(Response)(response),
          (text) => sql`
            UPDATE chat_interrupts SET status = 'resolved', resolved_at = ${resolvedAt}, response = ${text}
            WHERE interrupt_id = ${interruptId}`,
        ),
      Cancelled: ({ interruptId }) => sql`
        UPDATE chat_interrupts SET status = 'cancelled', resolved_at = ${resolvedAt}
        WHERE interrupt_id = ${interruptId}`,
    });

  /** Answers a batch of interrupts at once, or none of them. */
  const commitInterrupts = Effect.fn("RunStore.commitInterrupts")(function* (
    answers: ReadonlyArray<InterruptAnswer>,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Effect.reduce(answers, HashSet.empty<string>, (seen, { interruptId }) =>
          HashSet.has(seen, interruptId)
            ? Effect.fail(rejected("duplicate-interrupt", interruptId))
            : Effect.as(checkPending(interruptId), HashSet.add(seen, interruptId)),
        );
        yield* Effect.forEach(answers, answered(yield* Clock.currentTimeMillis), {
          discard: true,
        });
      }),
    );
  });

  /**
   * Retires the approvals a page can still show after their continuation was lost. The gated tool
   * never runs: the interrupts are cancelled and their run fails, so the thread can take a new turn.
   * Gives how many interrupts it cancelled.
   */
  const discardPendingInterrupts = Effect.fn("RunStore.discardPendingInterrupts")(function* (
    threadId: string,
  ) {
    const discardedAt = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const discarded = yield* sql`
          UPDATE chat_interrupts SET status = 'cancelled', resolved_at = ${discardedAt}
          WHERE thread_id = ${threadId} AND status = 'pending'
          RETURNING interrupt_id`;
        yield* Effect.when(
          sql`
            UPDATE chat_runs
            SET status = 'failed', finished_at = ${discardedAt},
                error = 'The approval continuation was no longer available, so the request was discarded.',
                error_code = ${interruptContinuationLostCode}
            WHERE thread_id = ${threadId} AND status IN ('running', 'interrupted')`,
          Effect.succeed(discarded.length > 0),
        );
        return discarded.length;
      }),
    );
  });

  const metadataRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ namespace: Schema.String, key: Schema.String }),
    Result: Schema.Struct({ value: Value }),
    execute: ({ namespace, key }) =>
      sql`SELECT value FROM chat_metadata WHERE namespace = ${namespace} AND key = ${key}`,
  });

  const metadata = {
    get: (namespace: string, key: string) =>
      Effect.map(
        metadataRow({ namespace, key }),
        Option.map((row) => row.value),
      ),
    set: Effect.fn("RunStore.metadata.set")(function* (
      namespace: string,
      key: string,
      value: JsonValue,
    ) {
      const text = yield* Schema.encodeEffect(Value)(value);
      yield* sql`
        INSERT INTO chat_metadata VALUES (${namespace}, ${key}, ${text})
        ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`;
    }),
    delete: (namespace: string, key: string) =>
      Effect.asVoid(sql`DELETE FROM chat_metadata WHERE namespace = ${namespace} AND key = ${key}`),
  };

  /** The same rows as compaction, model handoff and context usage use them. */
  const chatMetadata: ChatMetadata = {
    get: (namespace, key) =>
      metadata.get(namespace, key).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => ChatMetadataFailed.make({ cause })),
      ),
    set: (namespace, key, value) =>
      Effect.mapError(metadata.set(namespace, key, value), (cause) =>
        ChatMetadataFailed.make({ cause }),
      ),
  };

  return {
    thread,
    threadSaved,
    historyPage: history.read,
    activeRun,
    saveThread,
    startRun,
    endRun,
    run,
    lastRun,
    pendingInterrupts,
    createInterrupts,
    commitInterrupts,
    discardPendingInterrupts,
    metadata,
    chatMetadata,
  };
});

/** Chat rows of the Effect AI loop, which the app reads too. */
export class RunStore extends Context.Service<RunStore, Effect.Success<typeof make>>()(
  "memory-agent/loop/store/RunStore",
) {
  static readonly layer = Layer.effect(RunStore, make).pipe(
    Layer.provide(HistoryProjectionReader.layer),
  );
}
