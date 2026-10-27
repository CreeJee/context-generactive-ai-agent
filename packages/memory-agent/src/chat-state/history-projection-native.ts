import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { StoredMessage } from "../chat-store/schema.ts";
import {
  groupHistoryMessages,
  HistoryGroupingResult,
  HistoryMessagesResult,
  historyProjectionMessages,
} from "./history-groups.ts";
import { historyProjectionSchema, historyProjectionSql as sql } from "./history-projection-sql.ts";

export class HistoryPageUnavailable extends Schema.TaggedError<HistoryPageUnavailable>()(
  "HistoryPageUnavailable",
  {
    reason: Schema.Literals(["not-ready", "id-collision", "invalid-transcript"]),
  },
) {}
const unavailable = (reason: HistoryPageUnavailable["reason"]) =>
  Effect.fail(HistoryPageUnavailable.make({ reason }));
const Messages = Schema.fromJsonString(Schema.Array(StoredMessage));
/** A transcript that is not stored messages is invalid for every page. */
const decodeStored = Schema.decodeEffect(Messages);
const encodeGroup = Schema.encodeEffect(Messages);
const Identity = Schema.Struct({ ordinal: Schema.Natural, ui_id: Schema.String });

/** A transcript snapshot to project; a writer that has its `messages` supplies them. */
export interface HistorySnapshot {
  readonly threadId: string;
  readonly sourceJSON: string;
  readonly messages?: ReadonlyArray<StoredMessage>;
}

/** The UI history projection beside the authoritative transcript, on the app's SqlClient. */
export const historyProjection = Effect.fn("HistoryProjection.make")(function* () {
  const client = yield* SqlClient.SqlClient;
  yield* client.withTransaction(client.unsafe(historyProjectionSchema).unprepared);
  // Before the ordinal repair, only the retained IDs are read: a fractional ordinal is still there.
  const retainedIds = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ ui_id: Schema.String }),
    execute: (threadId) => client.unsafe(sql.groupIdentities, [threadId]),
  });
  const identities = SqlSchema.findAll({
    Request: Schema.String,
    Result: Identity,
    execute: (threadId) => client.unsafe(sql.groupIdentities, [threadId]),
  });
  const pendingThreads = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: Schema.Struct({ thread_id: Schema.String }),
    execute: (threadId) =>
      client.unsafe(
        `SELECT thread_id FROM chat_threads WHERE (?1 IS NULL OR thread_id=?1) AND NOT EXISTS (
          SELECT 1 FROM chat_history_projection
          WHERE chat_history_projection.thread_id=chat_threads.thread_id AND ready=1 AND format_version=1
        )`,
        [threadId],
      ),
  });
  const storedThread = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ thread_id: Schema.String, messages: Schema.String }),
    execute: (threadId) =>
      client`SELECT thread_id, messages FROM chat_threads WHERE thread_id = ${threadId}`,
  });

  const prepared = Effect.fnUntraced(function* (snapshot: HistorySnapshot) {
    // Startup/import still validates and decodes stored JSON. Avoid reparsing the writer's
    // freshly serialized snapshot.
    const stored =
      snapshot.messages ??
      (yield* decodeStored(snapshot.sourceJSON).pipe(
        Effect.mapError(() => HistoryPageUnavailable.make({ reason: "invalid-transcript" })),
      ));
    const retained = yield* retainedIds(snapshot.threadId);
    const normalized = historyProjectionMessages(
      snapshot.threadId,
      stored,
      retained.map((row) => row.ui_id),
    );
    const messages = yield* HistoryMessagesResult.$match(normalized, {
      "id-collision": () => unavailable("id-collision"),
      ready: ({ messages }) => Effect.succeed(messages),
    });
    return yield* HistoryGroupingResult.$match(groupHistoryMessages(snapshot.threadId, messages), {
      "id-collision": () => unavailable("id-collision"),
      ready: ({ groups }) => Effect.succeed(groups),
    });
  });

  /** Replaces a thread's groups; joins the caller's transaction, or opens one. */
  const replace = (snapshot: HistorySnapshot) =>
    client.withTransaction(
      Effect.gen(function* () {
        const groups = yield* prepared(snapshot);
        const { threadId } = snapshot;
        yield* client.unsafe(sql.markUnready, [threadId]);
        // Disposable non-STRICT SQLite rows can contain fractional ordinals.
        // Repair them before decoding metadata, and discard out-of-window values.
        yield* client.unsafe(sql.removeInvalidOrdinals, [threadId]);
        yield* client.unsafe(sql.removeTail, [threadId, groups.length]);
        const existing = yield* identities(threadId);
        // Delete only changed identities before upserting, so moved/swapped IDs
        // cannot collide with the unique cursor index. Unchanged JSON is not rewritten.
        yield* Effect.forEach(
          existing.filter(
            (row) => row.ordinal < groups.length && groups[row.ordinal]?.id !== row.ui_id,
          ),
          (row) => client.unsafe(sql.removeOrdinal, [threadId, row.ordinal]),
          { discard: true },
        );
        yield* Effect.forEach(
          groups,
          (group, ordinal) =>
            Effect.flatMap(encodeGroup(group.messages), (encoded) =>
              client.unsafe(sql.updateGroup, [threadId, ordinal, group.id, encoded]),
            ),
          { discard: true },
        );
        const published = yield* client.unsafe(`${sql.publishIfCurrent} RETURNING thread_id`, [
          threadId,
          snapshot.sourceJSON,
        ]);
        yield* Effect.when(unavailable("not-ready"), Effect.succeed(published.length === 0));
      }),
    );

  return {
    // Explicit startup/import preparation, never a page-read fallback. Read one
    // unprepared original at a time, preserving the released authoritative table.
    prepare: (threadId?: string) =>
      Effect.flatMap(pendingThreads(threadId ?? null), (ids) =>
        Effect.forEach(
          ids,
          ({ thread_id }) =>
            Effect.flatMap(storedThread(thread_id), (stored) =>
              replace({ threadId: stored.thread_id, sourceJSON: stored.messages }),
            ).pipe(
              // A corrupt/ambiguous UI projection must not stop unrelated sessions.
              // Its original stays authoritative and reads report not-ready explicitly.
              Effect.catchTag("HistoryPageUnavailable", () => Effect.void),
            ),
          { discard: true },
        ),
      ),
    // Called within the original writer's transaction immediately after the authoritative
    // upsert, so failure rolls back both original and projection.
    replace,
  };
});
