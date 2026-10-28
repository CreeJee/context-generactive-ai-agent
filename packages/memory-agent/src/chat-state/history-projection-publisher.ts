import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
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
export const HistoryProjectionPublicationResult = Schema.TaggedUnion({
  published: { groupCount: Schema.Natural },
  "source-changed": {},
});
export type HistoryProjectionPublicationResult = typeof HistoryProjectionPublicationResult.Type;

export const HistoryProjectionPublishReason = Schema.TaggedUnion({
  InvalidPublication: {},
  InvalidPreparedJson: {},
  SqliteWrite: { phase: Schema.Literals(["install", "publish"]) },
  SourceChanged: {},
});
const publishReason = HistoryProjectionPublishReason.cases;

export class HistoryProjectionPublishFailed extends Schema.TaggedError<
  HistoryProjectionPublishFailed,
  { readonly brand: unique symbol }
>()("HistoryProjectionPublishFailed", { reason: HistoryProjectionPublishReason }) {}

const decodePublication = Schema.decodeUnknownEffect(HistoryProjectionPublication);
const validateSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)));
const validateGroup = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Json).check(Schema.isMinLength(1))),
);

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
      const client = yield* SqlClient.SqlClient;
      yield* client.withTransaction(client.unsafe(historyProjectionSchema).unprepared).pipe(
        Effect.mapError(() =>
          HistoryProjectionPublishFailed.make({
            reason: publishReason.SqliteWrite.make({ phase: "install" }),
          }),
        ),
      );
      const publish = Effect.fn("HistoryProjectionPublisher.publish")(function* (
        input: HistoryProjectionPublication,
      ): Effect.fn.Return<HistoryProjectionPublicationResult, HistoryProjectionPublishFailed> {
        const publication = yield* decodePublication(input).pipe(
          Effect.mapError(() =>
            HistoryProjectionPublishFailed.make({
              reason: publishReason.InvalidPublication.make({}),
            }),
          ),
        );
        yield* validateSource(publication.sourceJSON).pipe(
          Effect.mapError(() =>
            HistoryProjectionPublishFailed.make({
              reason: publishReason.InvalidPreparedJson.make({}),
            }),
          ),
        );
        yield* Effect.forEach(
          publication.groups,
          (group) =>
            validateGroup(group.messages).pipe(
              Effect.mapError(() =>
                HistoryProjectionPublishFailed.make({
                  reason: publishReason.InvalidPreparedJson.make({}),
                }),
              ),
            ),
          { discard: true },
        );
        // One transaction: a source change fails it with this typed reason so every staged row
        // rolls back, and that exact reason is recovered outside it. Other failures propagate.
        const { threadId } = publication;
        return yield* client
          .withTransaction(
            Effect.gen(function* () {
              yield* client.unsafe(sql.markUnready, [threadId]);
              yield* client.unsafe(sql.removeGroups, [threadId]);
              yield* Effect.forEach(
                publication.groups,
                (group, ordinal) =>
                  client.unsafe(sql.insertGroup, [threadId, ordinal, group.id, group.messages]),
                { discard: true },
              );
              const published = yield* client.unsafe(
                `${sql.publishIfCurrent} RETURNING thread_id`,
                [threadId, publication.sourceJSON],
              );
              yield* Effect.when(
                Effect.fail(
                  HistoryProjectionPublishFailed.make({
                    reason: publishReason.SourceChanged.make({}),
                  }),
                ),
                Effect.succeed(published.length === 0),
              );
              return HistoryProjectionPublicationResult.cases.published.make({
                groupCount: publication.groups.length,
              });
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", () =>
              Effect.fail(
                HistoryProjectionPublishFailed.make({
                  reason: publishReason.SqliteWrite.make({ phase: "publish" }),
                }),
              ),
            ),
            Effect.catchReason("HistoryProjectionPublishFailed", "SourceChanged", () =>
              Effect.succeed(HistoryProjectionPublicationResult.cases["source-changed"].make({})),
            ),
          );
      });
      return HistoryProjectionPublisher.of({ publish });
    }),
  );
}
