import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { historyProjectionSchema, historyProjectionSql as sql } from "./history-projection-sql.ts";

// This is the prepared storage protocol, not the SDK's model-message codec.
// The preparation caller owns model/UI grouping and preserves all original data.
export const HistoryProjectionPublication = Schema.Struct({
  threadId: Schema.NonEmptyString,
  sourceJSON: Schema.NonEmptyString,
  groups: Schema.Array(
    Schema.Struct({ id: Schema.NonEmptyString, messages: Schema.NonEmptyString }),
  ),
});
export type HistoryProjectionPublication = typeof HistoryProjectionPublication.Type;
export const HistoryProjectionPublicationResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("published"), groupCount: Schema.Natural }),
  Schema.Struct({ type: Schema.Literal("source-changed") }),
]);
export type HistoryProjectionPublicationResult = typeof HistoryProjectionPublicationResult.Type;

export class HistoryProjectionPublishFailed extends Schema.TaggedError<HistoryProjectionPublishFailed>()(
  "HistoryProjectionPublishFailed",
  {
    reason: Schema.Union([
      Schema.TaggedStruct("InvalidPublication", {}),
      Schema.TaggedStruct("InvalidPreparedJson", {}),
      Schema.TaggedStruct("SqliteWrite", {
        phase: Schema.Literals(["install", "prepare", "publish"]),
      }),
      Schema.TaggedStruct("SourceChanged", {}),
    ]),
  },
) {}

const decodePublication = Schema.decodeUnknownEffect(HistoryProjectionPublication);
const validateSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)));
const validateGroup = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Json).check(Schema.isMinLength(1))),
);
const isPublicationFailure = Schema.is(HistoryProjectionPublishFailed);

/** Publishes prepared snapshots; never invoked by page reads or connected to production yet. */
export class HistoryProjectionPublisher extends Context.Service<
  HistoryProjectionPublisher,
  {
    readonly publish: (
      publication: HistoryProjectionPublication,
    ) => Effect.Effect<HistoryProjectionPublicationResult, HistoryProjectionPublishFailed>;
  }
>()("memory-agent/chat-state/history-projection-publisher/HistoryProjectionPublisher") {
  static readonly layer = Layer.effect(
    HistoryProjectionPublisher,
    Effect.gen(function* () {
      const database = yield* Database;
      // Narrow native DDL boundary; the existing Database owns the transaction and connection.
      yield* Effect.try({
        try: () => database.atomic(() => database.sqlite.exec(historyProjectionSchema)),
        catch: () =>
          HistoryProjectionPublishFailed.make({
            reason: { _tag: "SqliteWrite", phase: "install" },
          }),
      });
      const statements = yield* Effect.try({
        try: () => ({
          invalidate: database.sqlite.prepare(sql.markUnready),
          remove: database.sqlite.prepare(sql.removeGroups),
          insert: database.sqlite.prepare(sql.insertGroup),
          publish: database.sqlite.prepare(sql.publishIfCurrent),
        }),
        catch: () =>
          HistoryProjectionPublishFailed.make({
            reason: { _tag: "SqliteWrite", phase: "prepare" },
          }),
      });
      const publish = Effect.fn("HistoryProjectionPublisher.publish")(function* (
        input: HistoryProjectionPublication,
      ): Effect.fn.Return<HistoryProjectionPublicationResult, HistoryProjectionPublishFailed> {
        const publication = yield* decodePublication(input).pipe(
          Effect.mapError(() =>
            HistoryProjectionPublishFailed.make({ reason: { _tag: "InvalidPublication" } }),
          ),
        );
        yield* validateSource(publication.sourceJSON).pipe(
          Effect.mapError(() =>
            HistoryProjectionPublishFailed.make({ reason: { _tag: "InvalidPreparedJson" } }),
          ),
        );
        yield* Effect.forEach(
          publication.groups,
          (group) =>
            validateGroup(group.messages).pipe(
              Effect.mapError(() =>
                HistoryProjectionPublishFailed.make({ reason: { _tag: "InvalidPreparedJson" } }),
              ),
            ),
          { discard: true },
        );
        // One synchronous SQLite transaction: there are no fiber yields inside native
        // atomic work. Throw only this typed condition through the owner's rollback
        // boundary, then recover that exact reason outside it. Other failures propagate.
        return yield* Effect.try({
          try: (): HistoryProjectionPublicationResult =>
            database.atomic(() => {
              statements.invalidate.run(publication.threadId);
              statements.remove.run(publication.threadId);
              for (const [ordinal, group] of publication.groups.entries()) {
                statements.insert.run(publication.threadId, ordinal, group.id, group.messages);
              }
              if (
                statements.publish.run(publication.threadId, publication.sourceJSON).changes === 0
              ) {
                throw HistoryProjectionPublishFailed.make({ reason: { _tag: "SourceChanged" } });
              }
              return { type: "published", groupCount: publication.groups.length };
            }),
          catch: (cause) =>
            isPublicationFailure(cause)
              ? cause
              : HistoryProjectionPublishFailed.make({
                  reason: { _tag: "SqliteWrite", phase: "publish" },
                }),
        }).pipe(
          Effect.catchReason("HistoryProjectionPublishFailed", "SourceChanged", () =>
            Effect.succeed({ type: "source-changed" } as const),
          ),
        );
      });
      return HistoryProjectionPublisher.of({ publish });
    }),
  );
}
