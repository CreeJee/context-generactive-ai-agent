import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Latch,
  Layer,
  Match,
  MutableHashMap,
} from "effect";
import { Crypto, Option, Predicate, Schema, Scope } from "effect";
import { PersistedQueue } from "effect/persistence";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * `PersistedQueueStore` on the owner Database connection (`persisted_queue_items`), so card runs
 * and the board share one SQLite file and one writer. `PersistedQueue.layerStoreSql` needs an
 * `effect/sql` driver of its own; this adapter keeps the store contract on the existing connection.
 *
 * Only the owner process builds this store. A row claimed by an earlier owner process is released
 * when the store starts: that process is gone, so its attempt stays counted and the element is
 * delivered again (at-least-once). Handlers continue the card; they never replay its effects.
 */

const ClaimedRow = Schema.Struct({
  sequence: Schema.Finite,
  id: Schema.String,
  element_json: Schema.String,
  attempts: Schema.Finite,
});
const NextRow = Schema.Struct({ next: Schema.NullOr(Schema.Finite) });
const StateRow = Schema.Struct({
  state: Schema.Literals(["pending", "completed", "failed"]),
  attempts: Schema.Finite,
  acquired_by: Schema.NullOr(Schema.String),
  last_failure: Schema.NullOr(Schema.String),
  updated_at: Schema.Finite,
});
const DeadLetterRow = Schema.Struct({
  id: Schema.String,
  attempts: Schema.Finite,
  last_failure: Schema.NullOr(Schema.String),
  updated_at: Schema.Finite,
});
const JsonElement = Schema.fromJsonString(Schema.Unknown);

export type PersistedQueueItemState = (typeof StateRow.Type)["state"];

/** A dead-lettered element: its attempts ran out or its payload could not be decoded. */
export interface DeadLetteredItem {
  readonly id: string;
  readonly attempts: number;
  /** Error tags of the last failure only, never provider bodies or prompts. */
  readonly lastFailure: string | null;
  readonly failedAt: number;
}

export interface PersistedQueueItemStatus {
  readonly state: PersistedQueueItemState;
  readonly attempts: number;
  readonly claimed: boolean;
  readonly lastFailure: string | null;
  readonly updatedAt: number;
}

export const PersistedQueueItemsReason = Schema.TaggedUnion({
  NotFound: {},
  NotDeadLettered: { state: Schema.Literals(["pending", "completed"]) },
  StorageFailed: {},
});
export type PersistedQueueItemsReason = typeof PersistedQueueItemsReason.Type;

export class PersistedQueueItemsFailed extends Schema.TaggedError<PersistedQueueItemsFailed>()(
  "PersistedQueueItemsFailed",
  {
    operation: Schema.Literals(["status", "dead_letters", "requeue"]),
    reason: PersistedQueueItemsReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The factory's private signal for a payload that can never decode. It has no public guard, so the
 * store recognises it by tag like the first-party stores do.
 */
const isDeadLetterSignal = Predicate.isTagged("~effect/persistence/PersistedQueue/DeadLetter");

/** Error tags only: a failure cause can carry provider bodies, prompts or paths. */
const failureSummary = (cause: Cause.Cause<unknown>) => {
  const tags = cause.reasons.map((reason) =>
    Match.valueTags(reason, {
      Fail: ({ error }) =>
        Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
          ? error._tag
          : "Failure",
      Die: () => "Defect",
      Interrupt: () => "Interrupted",
    }),
  );
  return [...new Set(tags)].join(",");
};

/**
 * What a take's exit does to its element, per the store contract: success completes it, an
 * interruption hands it back without counting the attempt, an undecodable payload or the last
 * allowed attempt dead-letters it, and any other failure retries it after the queue's delay.
 */
type Settlement = Data.TaggedEnum<{
  Complete: {};
  Release: {};
  DeadLetter: { readonly cause: Cause.Cause<unknown> };
  Retry: { readonly cause: Cause.Cause<unknown> };
}>;
const Settlement = Data.taggedEnum<Settlement>();

const settlementOf = (
  exit: Exit.Exit<unknown, unknown>,
  attempts: number,
  maxAttempts: number,
): Settlement =>
  Exit.match(exit, {
    onSuccess: (): Settlement => Settlement.Complete(),
    onFailure: (cause): Settlement =>
      cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && isDeadLetterSignal(reason.error),
      ) ||
      (attempts >= maxAttempts && !Cause.hasInterruptsOnly(cause))
        ? Settlement.DeadLetter({ cause })
        : Cause.hasInterruptsOnly(cause)
          ? Settlement.Release()
          : Settlement.Retry({ cause }),
  });

const make = Effect.fnUntraced(function* (options?: {
  /** Longest wait between looks when nothing in this process announced new work. */
  readonly pollInterval?: Duration.Input | undefined;
}) {
  const clock = yield* Clock.Clock;
  const sql = yield* SqlClient.SqlClient;
  const pollMillis = Math.max(
    1,
    Duration.toMillis(Duration.fromInputUnsafe(options?.pollInterval ?? Duration.seconds(5))),
  );
  // Names this owner process on the rows it claims; v7 sorts by start time in the table.
  const worker = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv7()).pipe(
    Effect.mapError((cause) =>
      PersistedQueue.PersistedQueueError.make({
        message: "Failed to name the queue owner",
        cause,
      }),
    ),
  );
  const now = () => clock.currentTimeMillisUnsafe();
  const queueError = (message: string) => (cause: SqlError.SqlError | Schema.SchemaError) =>
    PersistedQueue.PersistedQueueError.make({ message, cause });

  // Single-threaded owner: every statement below is one synchronous SQLite step, so a claim cannot
  // interleave with another claim. The latch only shortens waits for work offered in this process.
  const latches = MutableHashMap.empty<string, Latch.Latch>();
  const latchFor = (name: string) =>
    Option.getOrElse(MutableHashMap.get(latches, name), () => {
      const latch = Latch.makeUnsafe(false);
      MutableHashMap.set(latches, name, latch);
      return latch;
    });
  const nudge = (name: string) =>
    Effect.asVoid(
      Effect.sync(() =>
        Option.map(MutableHashMap.get(latches, name), (latch) => latch.openUnsafe()),
      ),
    );

  yield* sql`UPDATE persisted_queue_items SET acquired_by = NULL WHERE acquired_by IS NOT NULL`.pipe(
    Effect.mapError(queueError("Failed to release persisted queue items of an earlier owner")),
  );

  const settle = (sequence: number, update: Effect.Effect<unknown, SqlError.SqlError>) =>
    update.pipe(
      // A finalizer cannot fail. The row stays claimed by this process and is released on restart.
      Effect.tapCause((cause) =>
        Effect.logError("Failed to settle a persisted queue item", { sequence, cause }),
      ),
      Effect.orDie,
      Effect.asVoid,
    );
  const markFailed = (sequence: number, cause: Cause.Cause<unknown>) =>
    settle(
      sequence,
      sql`UPDATE persisted_queue_items
          SET state = 'failed', acquired_by = NULL, last_failure = ${failureSummary(cause)}, updated_at = ${now()}
          WHERE sequence = ${sequence} AND acquired_by = ${worker}`,
    );

  const takeOne = (options: {
    readonly name: string;
    readonly maxAttempts: number;
    readonly retryDelay: (attempts: number) => Effect.Effect<Duration.Duration>;
  }) =>
    Effect.gen(function* () {
      const at = now();
      // An earlier owner may have crashed during the final attempt; no finalizer will settle it.
      yield* sql`UPDATE persisted_queue_items
          SET state = 'failed', last_failure = COALESCE(last_failure, 'Crashed after final attempt'), updated_at = ${at}
          WHERE queue_name = ${options.name} AND state = 'pending' AND acquired_by IS NULL
            AND attempts >= ${options.maxAttempts}`;
      const rows = yield* sql`UPDATE persisted_queue_items
          SET acquired_by = ${worker}, attempts = attempts + 1, updated_at = ${at}
          WHERE sequence = (
            SELECT sequence FROM persisted_queue_items
            WHERE queue_name = ${options.name} AND state = 'pending' AND acquired_by IS NULL
              AND attempts < ${options.maxAttempts} AND visible_at <= ${at}
            ORDER BY visible_at, sequence LIMIT 1)
          RETURNING sequence, id, element_json, attempts`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ClaimedRow))),
      );
      const row = rows[0];
      if (row === undefined) return Option.none();
      yield* Effect.addFinalizer((exit) =>
        Match.valueTags(settlementOf(exit, row.attempts, options.maxAttempts), {
          Complete: () =>
            settle(
              row.sequence,
              sql`UPDATE persisted_queue_items
                  SET state = 'completed', acquired_by = NULL, updated_at = ${now()}
                  WHERE sequence = ${row.sequence} AND acquired_by = ${worker}`,
            ),
          Release: () =>
            settle(
              row.sequence,
              sql`UPDATE persisted_queue_items
                  SET acquired_by = NULL, attempts = attempts - 1, updated_at = ${now()}
                  WHERE sequence = ${row.sequence} AND acquired_by = ${worker}`,
            ),
          DeadLetter: ({ cause }) => markFailed(row.sequence, cause),
          Retry: ({ cause }) =>
            Effect.flatMap(options.retryDelay(row.attempts), (delay) =>
              settle(
                row.sequence,
                sql`UPDATE persisted_queue_items
                    SET acquired_by = NULL, visible_at = ${now() + Duration.toMillis(delay)},
                        last_failure = ${failureSummary(cause)}, updated_at = ${now()}
                    WHERE sequence = ${row.sequence} AND acquired_by = ${worker}`,
              ),
            ),
        }),
      );
      return Option.some(row);
    });

  const nextVisible = (name: string, maxAttempts: number) =>
    sql`SELECT MIN(visible_at) AS next FROM persisted_queue_items
        WHERE queue_name = ${name} AND state = 'pending' AND acquired_by IS NULL
          AND attempts < ${maxAttempts}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(NextRow))),
      Effect.map((rows) => rows[0]?.next ?? null),
    );

  const store = PersistedQueue.PersistedQueueStore.of({
    offer: ({ name, id, element, delay }) =>
      Effect.gen(function* () {
        const json = yield* Schema.encodeEffect(JsonElement)(element);
        const at = now();
        yield* sql`INSERT OR IGNORE INTO persisted_queue_items
            (queue_name, id, element_json, state, attempts, visible_at, created_at, updated_at)
            VALUES (${name}, ${id}, ${json}, 'pending', 0, ${delay === undefined ? at : at + Duration.toMillis(delay)}, ${at}, ${at})`;
      }).pipe(
        Effect.mapError(queueError("Failed to offer element to persisted queue")),
        Effect.andThen(nudge(name)),
        Effect.asVoid,
      ),

    take: (options) =>
      Effect.uninterruptibleMask((restore) => {
        const latch = latchFor(options.name);
        const loop: Effect.Effect<
          { readonly id: string; readonly attempts: number; readonly element: unknown },
          PersistedQueue.PersistedQueueError | SqlError.SqlError | Schema.SchemaError,
          Scope.Scope
        > = Effect.gen(function* () {
          // Close before looking, so an offer after the look reopens it.
          latch.closeUnsafe();
          const claimed = yield* takeOne(options);
          if (Option.isSome(claimed)) {
            const row = claimed.value;
            const element = yield* Schema.decodeEffect(JsonElement)(row.element_json).pipe(
              // A payload that is not JSON can never succeed: dead-letter it and take the next one.
              Effect.catchTag("SchemaError", (cause) =>
                markFailed(row.sequence, Cause.fail(cause)).pipe(Effect.andThen(loop)),
              ),
            );
            return { id: row.id, attempts: row.attempts, element };
          }
          const next = yield* nextVisible(options.name, options.maxAttempts);
          const wait = next === null ? pollMillis : Math.min(pollMillis, Math.max(0, next - now()));
          yield* restore(Effect.race(latch.await, Effect.sleep(Duration.millis(wait))));
          return yield* loop;
        });
        return loop;
      }).pipe(
        Effect.catchTag(["SqlError", "SchemaError"], (cause) =>
          Effect.fail(queueError("Failed to take element from persisted queue")(cause)),
        ),
      ),

    cleanup: ({ timeToLive, failedTimeToLive }) =>
      Effect.gen(function* () {
        const at = now();
        yield* sql`DELETE FROM persisted_queue_items
            WHERE state = 'completed' AND updated_at <= ${at - Duration.toMillis(timeToLive)}`;
        if (failedTimeToLive !== undefined)
          yield* sql`DELETE FROM persisted_queue_items
              WHERE state = 'failed' AND updated_at <= ${at - Duration.toMillis(failedTimeToLive)}`;
      }).pipe(Effect.mapError(queueError("Failed to clean up persisted queue"))),
  });

  const itemsError =
    (operation: PersistedQueueItemsFailed["operation"]) =>
    (cause: SqlError.SqlError | Schema.SchemaError) =>
      PersistedQueueItemsFailed.make({
        operation,
        reason: PersistedQueueItemsReason.cases.StorageFailed.make({}),
        cause,
      });

  const status = Effect.fn("PersistedQueueItems.status")(function* (name: string, id: string) {
    const rows = yield* sql`SELECT state, attempts, acquired_by, last_failure, updated_at
        FROM persisted_queue_items WHERE queue_name = ${name} AND id = ${id}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StateRow))),
      Effect.mapError(itemsError("status")),
    );
    return Option.map(Option.fromUndefinedOr(rows[0]), (row): PersistedQueueItemStatus => ({
      state: row.state,
      attempts: row.attempts,
      claimed: row.acquired_by !== null,
      lastFailure: row.last_failure,
      updatedAt: row.updated_at,
    }));
  });

  const items = {
    status,

    /** The dead-letter record of one queue, oldest failure first. */
    deadLetters: (name: string) =>
      sql`SELECT id, attempts, last_failure, updated_at FROM persisted_queue_items
          WHERE queue_name = ${name} AND state = 'failed' ORDER BY updated_at, sequence`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DeadLetterRow))),
        Effect.map((rows) =>
          rows.map((row): DeadLetteredItem => ({
            id: row.id,
            attempts: row.attempts,
            lastFailure: row.last_failure,
            failedAt: row.updated_at,
          })),
        ),
        Effect.mapError(itemsError("dead_letters")),
      ),

    /**
     * Puts a dead-lettered element back with a fresh attempt budget, keeping its id so offer
     * de-duplication still holds. Only failed elements move; anything else is refused by reason.
     */
    requeue: Effect.fn("PersistedQueueItems.requeue")(function* (name: string, id: string) {
      const current = yield* status(name, id).pipe(
        Effect.mapError((error) =>
          PersistedQueueItemsFailed.make({
            operation: "requeue",
            reason: error.reason,
            cause: error.cause,
          }),
        ),
      );
      const refuse = (reason: PersistedQueueItemsFailed["reason"]) =>
        PersistedQueueItemsFailed.make({ operation: "requeue", reason });
      if (Option.isNone(current))
        return yield* refuse(PersistedQueueItemsReason.cases.NotFound.make({}));
      const state = current.value.state;
      switch (state) {
        case "pending":
        case "completed":
          return yield* refuse(PersistedQueueItemsReason.cases.NotDeadLettered.make({ state }));
        case "failed": {
          // Status and update run back to back on the single owner connection.
          const at = now();
          yield* sql`UPDATE persisted_queue_items
              SET state = 'pending', attempts = 0, visible_at = ${at}, last_failure = NULL, updated_at = ${at}
              WHERE queue_name = ${name} AND id = ${id} AND state = 'failed'`.pipe(
            Effect.mapError(itemsError("requeue")),
          );
          return yield* nudge(name);
        }
      }
    }),
  };

  return { store, items };
});

/** Dead-letter inspection and requeue for the owner's persisted queues. */
export class PersistedQueueItems extends Context.Service<
  PersistedQueueItems,
  Effect.Success<ReturnType<typeof make>>["items"]
>()("memory-agent/kanban/persisted-queue-store/PersistedQueueItems") {}

/** The owner-connection store plus its item inspection; build once, in the owner process. */
export const persistedQueueStoreLayer = (options?: Parameters<typeof make>[0]) =>
  Layer.effectContext(
    Effect.map(make(options), ({ store, items }) =>
      Context.make(PersistedQueue.PersistedQueueStore, store).pipe(
        Context.add(PersistedQueueItems, items),
      ),
    ),
  );

/**
 * Removes completed elements after their de-duplication window. Failed elements stay as the
 * dead-letter record unless `failedTimeToLive` is set. Run it in the owner only.
 */
export const persistedQueueCleanupLayer = PersistedQueue.layerCleanup;
