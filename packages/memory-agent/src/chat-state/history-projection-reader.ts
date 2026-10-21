import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { historyProjectionSnapshots } from "./history-projection-sql.ts";

const PageSize = Schema.Int.check(Schema.isGreaterThan(0));
export const HistoryPageRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("initial"),
    threadId: Schema.NonEmptyString,
    limit: PageSize,
  }),
  Schema.Struct({
    type: Schema.Literal("older"),
    threadId: Schema.NonEmptyString,
    limit: PageSize,
    before: Schema.NonEmptyString,
  }),
]);
export type HistoryPageRequest = typeof HistoryPageRequest.Type;

const stateFields = {
  ready: Schema.Literals([0, 1]),
  format_version: Schema.Natural,
  cursor_valid: Schema.Literals([0, 1]),
  has_earlier: Schema.Literals([0, 1]),
};
export const HistorySnapshotRows = Schema.Array(
  Schema.Union([
    Schema.Struct({
      ...stateFields,
      ordinal: Schema.Null,
      ui_id: Schema.Null,
      messages: Schema.Null,
    }),
    Schema.Struct({
      ...stateFields,
      ordinal: Schema.Natural,
      ui_id: Schema.NonEmptyString,
      messages: Schema.NonEmptyString,
    }),
  ]),
).check(Schema.isMinLength(1));
const Group = Schema.Struct({
  ordinal: Schema.Natural,
  uiId: Schema.NonEmptyString,
  messages: Schema.NonEmptyString,
});

export const HistoryPageSnapshot = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("not-ready"),
    reason: Schema.Literals(["unprepared", "stale", "unsupported-format"]),
  }),
  Schema.Struct({ type: Schema.Literal("unknown-cursor") }),
  Schema.Struct({
    type: Schema.Literal("page"),
    groups: Schema.Array(Group),
    truncated: Schema.Boolean,
    nextCursor: Schema.NullOr(Schema.NonEmptyString),
  }),
]);
export type HistoryPageSnapshot = typeof HistoryPageSnapshot.Type;

export const HistoryProjectionReadReason = Schema.TaggedUnion({
  InvalidRequest: {},
  SqliteRead: { phase: Schema.Literal("query") },
  InvalidSnapshot: {},
});
const readReason = HistoryProjectionReadReason.cases;

export class HistoryProjectionReadFailed extends Schema.TaggedError<HistoryProjectionReadFailed>()(
  "HistoryProjectionReadFailed",
  { reason: HistoryProjectionReadReason },
) {}

const decodeRequest = Schema.decodeUnknownEffect(HistoryPageRequest);
const decodeRows = Schema.decodeUnknownEffect(HistorySnapshotRows);

/** Reads derived data only, on the app's SqlClient. */
export class HistoryProjectionReader extends Context.Service<
  HistoryProjectionReader,
  {
    readonly read: (
      request: HistoryPageRequest,
    ) => Effect.Effect<HistoryPageSnapshot, HistoryProjectionReadFailed>;
  }
>()("memory-agent/chat-state/history-projection-reader/HistoryProjectionReader") {
  static readonly layer = Layer.effect(
    HistoryProjectionReader,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = Effect.fn("HistoryProjectionReader.read")(function* (
        input: HistoryPageRequest,
      ): Effect.fn.Return<HistoryPageSnapshot, HistoryProjectionReadFailed> {
        const request = yield* decodeRequest(input).pipe(
          Effect.mapError(() =>
            HistoryProjectionReadFailed.make({ reason: readReason.InvalidRequest.make({}) }),
          ),
        );
        const raw = yield* (() => {
          switch (request.type) {
            case "initial":
              return sql.unsafe(historyProjectionSnapshots.initial, [
                request.threadId,
                request.limit,
              ]);
            case "older":
              return sql.unsafe(historyProjectionSnapshots.older, [
                request.threadId,
                request.before,
                request.limit,
              ]);
          }
        })().pipe(
          Effect.mapError(() =>
            HistoryProjectionReadFailed.make({
              reason: readReason.SqliteRead.make({ phase: "query" }),
            }),
          ),
        );
        const rows = yield* decodeRows(raw).pipe(
          Effect.mapError(() =>
            HistoryProjectionReadFailed.make({ reason: readReason.InvalidSnapshot.make({}) }),
          ),
        );
        const state = rows[0];
        if (state === undefined)
          return yield* HistoryProjectionReadFailed.make({
            reason: readReason.InvalidSnapshot.make({}),
          });
        if (state.format_version === 0) return { type: "not-ready", reason: "unprepared" };
        if (state.format_version !== 1) return { type: "not-ready", reason: "unsupported-format" };
        if (state.ready === 0) return { type: "not-ready", reason: "stale" };
        if (state.cursor_valid === 0) return { type: "unknown-cursor" };
        // Do not parse arbitrary model-message JSON here. The SDK codec/adapter must
        // validate and decode these selected groups, never the authoritative transcript.
        const groups: Array<typeof Group.Type> = [];
        for (const row of rows) {
          if (row.ordinal !== null)
            groups.push({ ordinal: row.ordinal, uiId: row.ui_id, messages: row.messages });
        }
        groups.sort((a, b) => a.ordinal - b.ordinal);
        const truncated = state.has_earlier === 1;
        return {
          type: "page",
          groups,
          truncated,
          nextCursor: truncated ? (groups[0]?.uiId ?? null) : null,
        };
      });
      return HistoryProjectionReader.of({ read });
    }),
  );
}
