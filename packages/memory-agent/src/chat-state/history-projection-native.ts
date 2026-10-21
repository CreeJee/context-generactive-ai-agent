import type { ModelMessage } from "@tanstack/ai";
import type { MessagePage } from "@tanstack/ai-persistence";
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import {
  groupHistoryMessages,
  HistoryGroupingResult,
  HistoryMessagesResult,
  historyProjectionMessages,
} from "./history-groups.ts";
import { HistoryPageRequest, HistorySnapshotRows } from "./history-projection-reader.ts";
import {
  historyProjectionSchema,
  historyProjectionSnapshots,
  historyProjectionSql as sql,
} from "./history-projection-sql.ts";

export class HistoryPageUnavailable extends Schema.TaggedError<HistoryPageUnavailable>()(
  "HistoryPageUnavailable",
  {
    reason: Schema.Literals(["not-ready", "id-collision", "invalid-transcript"]),
  },
) {}
const unavailable = (reason: HistoryPageUnavailable["reason"]) =>
  Effect.fail(HistoryPageUnavailable.make({ reason }));
const validateStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant", "tool"]),
        id: Schema.optional(Schema.String),
      }),
    ),
  ),
);
const encodeGroup = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const Identity = Schema.Struct({ ordinal: Schema.Natural, ui_id: Schema.String });

/** A transcript snapshot to project; only the typed SDK writer supplies `models`. */
export interface HistorySnapshot {
  readonly threadId: string;
  readonly sourceJSON: string;
  readonly models?: readonly ModelMessage[];
}

/**
 * The UI history projection beside the authoritative transcript, on the app's SqlClient. The
 * caller supplies the original model codec.
 */
export const historyProjection = Effect.fn("HistoryProjection.make")(function* (
  decodeMessages: (json: string) => ModelMessage[],
) {
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
  const snapshotRows = (request: HistoryPageRequest) =>
    Effect.flatMap(
      HistoryPageRequest.match(request, {
        initial: (initial) =>
          client.unsafe(historyProjectionSnapshots.initial, [initial.threadId, initial.limit]),
        older: (older) =>
          client.unsafe(historyProjectionSnapshots.older, [
            older.threadId,
            older.before,
            older.limit,
          ]),
      }),
      Schema.decodeUnknownEffect(HistorySnapshotRows),
    );
  const threadExists = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ present: Schema.Literals([0, 1]) }),
    execute: (threadId) =>
      client`SELECT EXISTS(SELECT 1 FROM chat_threads WHERE thread_id = ${threadId}) AS present`,
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
    if (snapshot.models === undefined)
      yield* validateStored(snapshot.sourceJSON).pipe(
        Effect.mapError(() => HistoryPageUnavailable.make({ reason: "invalid-transcript" })),
      );
    const retained = yield* retainedIds(snapshot.threadId);
    const normalized = historyProjectionMessages(
      snapshot.threadId,
      snapshot.models ?? decodeMessages(snapshot.sourceJSON),
      retained.map((row) => row.ui_id),
    );
    const models = yield* HistoryMessagesResult.$match(normalized, {
      "id-collision": () => unavailable("id-collision"),
      ready: ({ messages }) => Effect.succeed(messages),
    });
    for (const message of models) {
      switch (message.role) {
        case "user":
        case "assistant":
        case "tool":
          break;
        default:
          return yield* unavailable("invalid-transcript");
      }
    }
    return yield* HistoryGroupingResult.$match(groupHistoryMessages(snapshot.threadId, models), {
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
        for (const row of existing)
          if (row.ordinal < groups.length && groups[row.ordinal]?.id !== row.ui_id)
            yield* client.unsafe(sql.removeOrdinal, [threadId, row.ordinal]);
        for (const [ordinal, group] of groups.entries())
          yield* client.unsafe(sql.updateGroup, [
            threadId,
            ordinal,
            group.id,
            yield* encodeGroup(group.messages),
          ]);
        const published = yield* client.unsafe(`${sql.publishIfCurrent} RETURNING thread_id`, [
          threadId,
          snapshot.sourceJSON,
        ]);
        if (published.length === 0) return yield* unavailable("not-ready");
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
    load: Effect.fnUntraced(function* (request: HistoryPageRequest) {
      const checked = yield* Schema.decodeEffect(HistoryPageRequest)(request);
      const rows = yield* snapshotRows(checked);
      const state = rows[0];
      if (state === undefined || state.ready !== 1 || state.format_version !== 1) {
        const { present } = yield* threadExists(checked.threadId);
        if (present === 0) return { messages: [], truncated: false } satisfies MessagePage;
        return yield* unavailable("not-ready");
      }
      if (state.cursor_valid === 0) return { messages: [], truncated: false } satisfies MessagePage;
      const selected = rows
        .filter((row) => row.ordinal !== null)
        .toSorted((a, b) => Number(a.ordinal) - Number(b.ordinal));
      const messages = selected.flatMap((row) =>
        row.messages === null ? [] : decodeMessages(row.messages),
      );
      if (state.has_earlier === 1) {
        const cursor = selected[0]?.ui_id;
        if (cursor === undefined || cursor.length === 0) return yield* unavailable("not-ready");
        return { messages, truncated: true, cursor } satisfies MessagePage;
      }
      return { messages, truncated: false } satisfies MessagePage;
    }),
  };
});

export type HistoryProjection = Effect.Success<ReturnType<typeof historyProjection>>;

/** `Option` of a projection, for stores that run without one (tests, the SDK testkit). */
export type MaybeHistoryProjection = Option.Option<HistoryProjection>;
