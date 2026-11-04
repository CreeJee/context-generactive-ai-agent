import { Array as EffectArray, Effect, Equivalence, Option, Ref, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { StoredMessage } from "../chat-store/schema.ts";
import { threadMessages } from "../chat-store/thread-messages.ts";
import {
  groupHistoryMessages,
  type HistoryGroup,
  HistoryGroupingResult,
  HistoryMessagesResult,
  historyProjectionMessages,
} from "./history-groups.ts";
import { historyProjectionSchema, historyProjectionSql as sql } from "./history-projection-sql.ts";

export class HistoryPageUnavailable extends Schema.TaggedError<
  HistoryPageUnavailable,
  { readonly brand: unique symbol }
>()("HistoryPageUnavailable", {
  reason: Schema.Literals(["not-ready", "id-collision", "invalid-transcript"]),
}) {}
const unavailable = (reason: HistoryPageUnavailable["reason"]) =>
  Effect.fail(HistoryPageUnavailable.make({ reason }));
const Messages = Schema.fromJsonString(Schema.Array(StoredMessage));
/** A transcript that is not stored messages is invalid for every page. */
const decodeStored = Schema.decodeEffect(Messages);
const encodeGroup = Schema.encodeEffect(Messages);
const Identity = Schema.Struct({ ordinal: Schema.Natural, ui_id: Schema.String });
const Publication = Schema.Struct({ publication: Schema.NullOr(Schema.String) });

/** A thread's transcript to project, and the revision of the thread it was read or saved at. */
export interface HistorySnapshot {
  readonly threadId: string;
  readonly revision: number;
  readonly messages: ReadonlyArray<StoredMessage>;
}

/**
 * A thread's groups as a publish of this writer stored them. While the thread's stored publication
 * is still `publication`, its rows are these groups: one process owns the database, and a publish
 * that rolled back leaves the earlier publication in place.
 */
interface Published {
  readonly threadId: string;
  readonly publication: string;
  readonly groups: ReadonlyArray<HistoryGroup>;
}

/** How many threads' publishes a writer remembers: the most recently saved ones. */
const rememberedThreads = 4;

/**
 * Messages that hold the very same values, field by field. A message saved without an id is
 * published as a fresh copy that carries its id, so the copies of one message are told apart
 * from a changed message by their fields, not by the object.
 */
const sameMessages = EffectArray.makeEquivalence(Equivalence.Record(Equivalence.strictEqual()));

/**
 * Whether `group` is stored as is: the group published at its ordinal had its id and the very same
 * messages. A run saves its conversation again after each step with the earlier messages
 * unchanged, so only the groups its new messages touch are encoded and written.
 */
const storedAsIs = (published: Option.Option<HistoryGroup>, group: HistoryGroup) =>
  Option.exists(
    published,
    (stored) => stored.id === group.id && sameMessages(stored.messages, group.messages),
  );

/** The UI history projection beside the authoritative transcript, on the app's SqlClient. */
export const historyProjection = Effect.fn("HistoryProjection.make")(function* () {
  const client = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(historyProjectionSchema).unprepared;
      const recorded = yield* client.unsafe(sql.hasPublication);
      yield* Effect.when(client.unsafe(sql.addPublication), Effect.succeed(recorded.length === 0));
    }),
  );
  const remembered = yield* Ref.make<ReadonlyArray<Published>>([]);
  const storedPublication = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Publication,
    execute: (threadId) => client.unsafe(sql.publication, [threadId]),
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
  const rows = yield* threadMessages;
  /** A stored thread to prepare; startup/import validates and decodes the stored messages. */
  const storedSnapshot = (
    threadId: string,
    stored: { readonly revision: number; readonly messages: string },
  ) =>
    decodeStored(stored.messages).pipe(
      Effect.mapError(() => HistoryPageUnavailable.make({ reason: "invalid-transcript" })),
      Effect.map((messages): HistorySnapshot => ({
        threadId,
        revision: stored.revision,
        messages,
      })),
    );

  const prepared = Effect.fnUntraced(function* (
    snapshot: HistorySnapshot,
    retained: ReadonlyArray<typeof Identity.Type>,
  ) {
    const normalized = historyProjectionMessages(
      snapshot.threadId,
      snapshot.messages,
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

  /** This writer's latest publish of the thread, while it is still the stored one. */
  const storedPublish = (threadId: string) =>
    Effect.gen(function* () {
      const stored = Option.flatMap(yield* storedPublication(threadId), (row) =>
        Option.fromNullishOr(row.publication),
      );
      return EffectArray.findFirst(
        yield* Ref.get(remembered),
        (publish) => publish.threadId === threadId && Option.contains(stored, publish.publication),
      );
    });

  /** Remembers the publish, forgetting the least recently saved thread past the limit. */
  const remember = (publish: Published) =>
    Ref.update(remembered, (publishes) =>
      EffectArray.takeRight(
        [...publishes.filter((other) => other.threadId !== publish.threadId), publish],
        rememberedThreads,
      ),
    );

  /** Writes a thread's groups and publishes them, in the caller's transaction or its own. */
  const publish = (snapshot: HistorySnapshot) =>
    client.withTransaction(
      Effect.gen(function* () {
        const { threadId } = snapshot;
        const known = yield* storedPublish(threadId);
        const before = Option.match(known, { onNone: () => [], onSome: (last) => last.groups });
        // The rows of this writer's stored publish need no read.
        const existing = yield* Option.match(known, {
          onNone: () => identities(threadId),
          onSome: (last) =>
            Effect.succeed(last.groups.map((group, ordinal) => ({ ordinal, ui_id: group.id }))),
        });
        const groups = yield* prepared(snapshot, existing);
        yield* client.unsafe(sql.markUnready, [threadId]);
        yield* client.unsafe(sql.removeTail, [threadId, groups.length]);
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
            Effect.when(
              Effect.flatMap(encodeGroup(group.messages), (encoded) =>
                client.unsafe(sql.updateGroup, [threadId, ordinal, group.id, encoded]),
              ),
              Effect.succeed(!storedAsIs(EffectArray.get(before, ordinal), group)),
            ),
          { discard: true },
        );
        const publication = yield* crypto.uuidV4();
        const published = yield* client.unsafe(`${sql.publishIfCurrent} RETURNING thread_id`, [
          threadId,
          snapshot.revision,
          publication,
        ]);
        yield* Effect.when(unavailable("not-ready"), Effect.succeed(published.length === 0));
        return { threadId, publication, groups };
      }),
    );

  /**
   * Replaces a thread's groups; joins the caller's transaction, or opens one. Only the groups that
   * changed since this writer's stored publish are encoded and written.
   */
  const replace = (snapshot: HistorySnapshot) => Effect.flatMap(publish(snapshot), remember);

  return {
    // Explicit startup/import preparation, never a page-read fallback. Read one
    // unprepared original at a time, preserving the released authoritative table.
    // A prepared thread is not remembered: its messages were decoded here, so no writer saves
    // the same objects again.
    prepare: (threadId?: string) =>
      Effect.flatMap(pendingThreads(threadId ?? null), (ids) =>
        Effect.forEach(
          ids,
          ({ thread_id }) =>
            rows.stored(thread_id).pipe(
              Effect.flatMap(
                Option.match({
                  // Deleted since it was listed: nothing to prepare.
                  onNone: () => Effect.void,
                  onSome: (stored) =>
                    Effect.asVoid(Effect.flatMap(storedSnapshot(thread_id, stored), publish)),
                }),
              ),
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
