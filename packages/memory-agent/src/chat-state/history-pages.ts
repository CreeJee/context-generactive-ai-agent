import { Array as Arr, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { displayFormat } from "./display-messages.ts";

/**
 * Pages of a thread's shown messages (`display-messages.ts`), newest first, on the app's
 * SqlClient. A page reads only its own messages from the transcript's rows.
 */

/** A saved thread whose shown messages are not current has no pages until they are built. */
export class HistoryPageUnavailable extends Schema.TaggedError<
  HistoryPageUnavailable,
  { readonly brand: unique symbol }
>()("HistoryPageUnavailable", { reason: Schema.Literal("not-ready") }) {}

const PageSize = Schema.Int.check(Schema.isGreaterThan(0));
export const HistoryPageRequest = Schema.TaggedUnion({
  initial: { threadId: Schema.NonEmptyString, limit: PageSize },
  older: { threadId: Schema.NonEmptyString, limit: PageSize, before: Schema.NonEmptyString },
});
export type HistoryPageRequest = typeof HistoryPageRequest.Type;

const stateFields = {
  is_current: Schema.Literals([0, 1]),
  display_format: Schema.Natural,
  cursor_valid: Schema.Literals([0, 1]),
  has_earlier: Schema.Literals([0, 1]),
};
/** One row per shown message of the page, or one row of state alone when it shows none. */
export const HistoryPageRows = Schema.Array(
  Schema.Union([
    Schema.Struct({
      ...stateFields,
      seq: Schema.Null,
      display_id: Schema.Null,
      messages: Schema.Null,
    }),
    Schema.Struct({
      ...stateFields,
      seq: Schema.Natural,
      display_id: Schema.NonEmptyString,
      messages: Schema.NonEmptyString,
    }),
  ]),
).check(Schema.isMinLength(1));

/** A shown message of a page: its messages' JSON array text, decoded by the snapshot. */
const PageMessage = Schema.Struct({
  seq: Schema.Natural,
  displayId: Schema.NonEmptyString,
  messages: Schema.NonEmptyString,
});

export const HistoryPageSnapshot = Schema.TaggedUnion({
  "not-ready": { reason: Schema.Literals(["unprepared", "stale", "unsupported-format"]) },
  "unknown-cursor": {},
  page: {
    shown: Schema.Array(PageMessage),
    truncated: Schema.Boolean,
    nextCursor: Schema.NullOr(Schema.NonEmptyString),
  },
});
export type HistoryPageSnapshot = typeof HistoryPageSnapshot.Type;
const snapshot = HistoryPageSnapshot.cases;

// One statement reads the state and the page together. The page holds only its shown messages,
// each joined from its run of transcript rows; the earlier-page probe reads the index only.
// A read with no page still returns one state row, so it is never taken for an empty thread.
const pageResult = `
SELECT state.is_current, state.display_format, state.cursor_valid, page.seq, page.display_id,
       CASE WHEN page.seq IS NULL THEN NULL ELSE '[' || (
         SELECT group_concat(m.message, ',' ORDER BY m.seq) FROM chat_thread_messages AS m
         WHERE m.thread_id = ?1 AND m.seq >= page.first_message_seq AND m.seq < COALESCE((
           SELECT n.first_message_seq FROM chat_thread_display_messages AS n
           WHERE n.thread_id = ?1 AND n.seq = page.seq + 1), 9223372036854775807)) || ']'
       END AS messages,
       EXISTS (SELECT 1 FROM chat_thread_display_messages
               WHERE thread_id = ?1 AND seq < (SELECT MIN(seq) FROM page)) AS has_earlier
FROM state LEFT JOIN page ON 1 = 1
`;

const threadState = `
  SELECT COALESCE(thread.display_format, 0) AS display_format,
         COALESCE(thread.display_revision = thread.revision, 0) AS is_current`;
const readable = `(SELECT is_current FROM state) = 1
    AND (SELECT display_format FROM state) = ${displayFormat}`;

export const historyPageQueries = {
  initial: `
WITH state AS (
  ${threadState}, 1 AS cursor_valid
  FROM (SELECT ?1 AS thread_id) AS input LEFT JOIN chat_threads AS thread USING (thread_id)
), page AS MATERIALIZED (
  SELECT seq, display_id, first_message_seq FROM chat_thread_display_messages
  WHERE thread_id = ?1 AND ${readable}
  ORDER BY seq DESC LIMIT ?2
)
${pageResult}`,
  older: `
WITH state AS (
  ${threadState}, cursor.seq IS NOT NULL AS cursor_valid, cursor.seq AS cursor_seq
  FROM (SELECT ?1 AS thread_id) AS input
  LEFT JOIN chat_threads AS thread USING (thread_id)
  LEFT JOIN chat_thread_display_messages AS cursor
    ON cursor.thread_id = input.thread_id AND cursor.display_id = ?2
), page AS MATERIALIZED (
  SELECT seq, display_id, first_message_seq FROM chat_thread_display_messages
  WHERE thread_id = ?1 AND seq < (SELECT cursor_seq FROM state) AND ${readable}
  ORDER BY seq DESC LIMIT ?3
)
${pageResult}`,
} as const;

export const HistoryPageReadReason = Schema.TaggedUnion({
  InvalidRequest: {},
  SqliteRead: { phase: Schema.Literal("query") },
  InvalidSnapshot: {},
});
const readReason = HistoryPageReadReason.cases;

export class HistoryPageReadFailed extends Schema.TaggedError<
  HistoryPageReadFailed,
  { readonly brand: unique symbol }
>()("HistoryPageReadFailed", { reason: HistoryPageReadReason }) {}

const decodeRequest = Schema.decodeUnknownEffect(HistoryPageRequest);
const decodeRows = Schema.decodeUnknownEffect(HistoryPageRows);

/** Reads pages of shown messages, on the app's SqlClient. */
export class HistoryPageReader extends Context.Service<
  HistoryPageReader,
  {
    readonly read: (
      request: HistoryPageRequest,
    ) => Effect.Effect<HistoryPageSnapshot, HistoryPageReadFailed>;
  }
>()("memory-agent/chat-state/history-pages/HistoryPageReader") {
  static readonly layer = Layer.effect(
    HistoryPageReader,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = Effect.fn("HistoryPageReader.read")(function* (
        input: HistoryPageRequest,
      ): Effect.fn.Return<HistoryPageSnapshot, HistoryPageReadFailed> {
        const request = yield* decodeRequest(input).pipe(
          Effect.mapError(() =>
            HistoryPageReadFailed.make({ reason: readReason.InvalidRequest.make({}) }),
          ),
        );
        const raw = yield* HistoryPageRequest.match(request, {
          initial: (initial) =>
            sql.unsafe(historyPageQueries.initial, [initial.threadId, initial.limit]),
          older: (older) =>
            sql.unsafe(historyPageQueries.older, [older.threadId, older.before, older.limit]),
        }).pipe(
          Effect.mapError(() =>
            HistoryPageReadFailed.make({ reason: readReason.SqliteRead.make({ phase: "query" }) }),
          ),
        );
        const rows = yield* decodeRows(raw).pipe(
          Effect.mapError(() =>
            HistoryPageReadFailed.make({ reason: readReason.InvalidSnapshot.make({}) }),
          ),
        );
        const state = yield* Effect.fromOption(Arr.head(rows), () =>
          HistoryPageReadFailed.make({ reason: readReason.InvalidSnapshot.make({}) }),
        );
        if (state.display_format === 0) return snapshot["not-ready"].make({ reason: "unprepared" });
        if (state.display_format !== displayFormat)
          return snapshot["not-ready"].make({ reason: "unsupported-format" });
        if (state.is_current === 0) return snapshot["not-ready"].make({ reason: "stale" });
        if (state.cursor_valid === 0) return snapshot["unknown-cursor"].make({});
        // The messages stay JSON text here; the chat snapshot (`snapshot.ts`) decodes the page's.
        const shown = rows
          .flatMap((row): Array<typeof PageMessage.Type> =>
            row.seq === null
              ? []
              : [{ seq: row.seq, displayId: row.display_id, messages: row.messages }],
          )
          .toSorted((a, b) => a.seq - b.seq);
        const truncated = state.has_earlier === 1;
        return snapshot.page.make({
          shown,
          truncated,
          nextCursor: truncated ? (shown[0]?.displayId ?? null) : null,
        });
      });
      return HistoryPageReader.of({ read });
    }),
  );
}
