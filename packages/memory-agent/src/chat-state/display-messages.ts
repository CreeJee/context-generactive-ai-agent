import {
  Array as Arr,
  Data,
  Effect,
  Function as EffectFunction,
  Iterable as EffectIterable,
  MutableHashSet,
  Option,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import type { StoredMessage } from "../chat-store/schema.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * What the screen shows of a thread, as `chat_thread_display_messages` keeps it: one row per
 * message the page shows. A shown message is a run of the transcript's messages, from its
 * `first_message_seq` up to the next one's: a user message, or an assistant message with its later
 * segments and tool results until the next user message. A tool result with no assistant before it
 * shows alone. The rows hold no copy of the messages; a page reads them from the transcript.
 */

/** How the rows of `chat_thread_display_messages` are made; a thread built another way is rebuilt. */
export const displayFormat = 1;

/** What grouping reads of a message. */
export type MessageIdentity = Pick<StoredMessage, "role" | "id">;

/** What the next message may join: the shown message an assistant began, by that message's id. */
type Joinable = Data.TaggedEnum<{
  Nothing: {};
  Answer: { readonly id: Option.Option<string> };
}>;
const Joinable = Data.taggedEnum<Joinable>();

/** The message's own id; an empty one is none. */
const ownId = (message: MessageIdentity) =>
  Option.filter(Option.fromNullishOr(message.id), (id) => id.length > 0);

/** Whether `message` belongs to the shown message before it instead of beginning one. */
const joins = (joinable: Joinable, message: MessageIdentity) =>
  Joinable.$match(joinable, {
    Nothing: () => false,
    Answer: ({ id }) =>
      message.role === "tool" ||
      (message.role === "assistant" &&
        Option.exists(id, (answer) =>
          Option.exists(
            ownId(message),
            (own) => own === answer || own.startsWith(`${answer}-segment-`),
          ),
        )),
  });

const after = (joinable: Joinable, message: MessageIdentity): Joinable =>
  message.role === "user"
    ? Joinable.Nothing()
    : message.role === "assistant" && !joins(joinable, message)
      ? Joinable.Answer({ id: ownId(message) })
      : joinable;

/**
 * The positions of the messages from `start` on that begin a shown message. The message at `start`
 * must begin one: what it begins depends only on itself, so the scan needs nothing before it.
 */
export const displayStarts: {
  (start: number): (messages: ReadonlyArray<MessageIdentity>) => ReadonlyArray<number>;
  (messages: ReadonlyArray<MessageIdentity>, start: number): ReadonlyArray<number>;
} = EffectFunction.dual(2, (messages: ReadonlyArray<MessageIdentity>, start: number) => {
  const tail = messages.slice(start);
  const before = Arr.scan(tail, Joinable.Nothing(), after);
  return tail.flatMap((message, index) =>
    Option.exists(Arr.get(before, index), (joinable) => !joins(joinable, message))
      ? [start + index]
      : [],
  );
});

/** The id a shown message asks for: its first message's, or one made from the thread and position. */
const preferredDisplayId = (threadId: string, seq: number, message: MessageIdentity) =>
  Option.getOrElse(ownId(message), () => `stored:${threadId}:${seq}`);

/** The ids tried for a shown message, in order. */
const candidates = (preferred: string) =>
  EffectIterable.makeBy((attempt) =>
    attempt === 0 ? preferred : `${preferred}:fallback:${attempt - 1}`,
  );

/**
 * The ids of the shown messages that begin at `starts`, positions in the thread's `messages`, given
 * the ids `taken` by the shown messages kept before them. A shown message takes its first message's
 * id when it is free. An id made for it, for a message without one or one whose id is taken, is the
 * first free fallback that no message of the thread carries either. The kept ones are never given
 * new ids.
 */
export const displayIds = ({
  threadId,
  messages,
  starts,
  taken,
}: {
  readonly threadId: string;
  readonly messages: ReadonlyArray<MessageIdentity>;
  readonly starts: ReadonlyArray<number>;
  readonly taken: Iterable<string>;
}): ReadonlyArray<string> => {
  const held = MutableHashSet.fromIterable(taken);
  /** Takes `id` when nothing holds it. */
  const claim = (id: string) =>
    Option.map(
      Option.liftPredicate(id, (free) => !MutableHashSet.has(held, free)),
      (free) => {
        MutableHashSet.add(held, free);
        return free;
      },
    );
  const begun = starts.flatMap((seq) =>
    Option.toArray(Option.map(Arr.get(messages, seq), (message) => ({ seq, message }))),
  );
  const own = begun.map(({ message }) => Option.flatMap(ownId(message), claim));
  // Only a made id needs every id the messages carry: a run's new messages carry their own.
  const carried = own.some(Option.isNone)
    ? MutableHashSet.fromIterable(messages.flatMap((message) => Option.toArray(ownId(message))))
    : MutableHashSet.empty<string>();
  const made = (seq: number, message: MessageIdentity) =>
    Option.getOrThrow(
      EffectIterable.findFirst(candidates(preferredDisplayId(threadId, seq, message)), (id) =>
        MutableHashSet.has(carried, id) ? Option.none() : claim(id),
      ),
    );
  return Arr.zipWith(begun, own, ({ seq, message }, claimed) =>
    Option.getOrElse(claimed, () => made(seq, message)),
  );
};

const LastKept = Schema.Struct({ seq: Schema.Int, first_message_seq: Schema.Int });
const Taken = Schema.Struct({ display_id: Schema.String });
const IdentityRow = Schema.Struct({
  seq: Schema.Int,
  role: Schema.Literals(["user", "assistant", "tool"]),
  id: Schema.NullOr(Schema.String),
});

/** Rows written per statement, far below SQLite's limit on bound values. */
const rowsPerInsert = 500;

/** Writes threads' shown messages, on the app's SqlClient. */
export const displayMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** The last shown message that begins before message `from`: it and those before it stay. */
  const lastKept = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, from: Schema.Int }),
    Result: LastKept,
    execute: ({ threadId, from }) => sql`
      SELECT seq, first_message_seq FROM chat_thread_display_messages
      WHERE thread_id = ${threadId} AND first_message_seq < ${from}
      ORDER BY seq DESC LIMIT 1`,
  });

  /** The ids kept shown messages hold among an id and its fallbacks. */
  const takenAmong = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String, preferred: Schema.String }),
    Result: Taken,
    execute: ({ threadId, preferred }) => sql`
      SELECT display_id FROM chat_thread_display_messages
      WHERE thread_id = ${threadId} AND (display_id = ${preferred}
        OR (display_id > ${`${preferred}:fallback:`} AND display_id < ${`${preferred}:fallback;`}))`,
  });

  /**
   * Rewrites the thread's shown messages from the one that holds message `from` on, for its
   * transcript `messages`, and marks them current. The shown messages before it stay with their
   * ids: they begin where they did. `from` 0 builds them all again.
   */
  const rewrite = (threadId: string, messages: ReadonlyArray<MessageIdentity>, from: number) =>
    Effect.gen(function* () {
      const kept = yield* lastKept({ threadId, from });
      const start = Option.match(kept, { onNone: () => 0, onSome: (row) => row.first_message_seq });
      const next = Option.match(kept, { onNone: () => 0, onSome: (row) => row.seq + 1 });
      yield* sql`
        DELETE FROM chat_thread_display_messages WHERE thread_id = ${threadId} AND seq >= ${next}`;
      // The kept message at `start` begins the scan; it is shown already.
      const starts = displayStarts(messages, start).slice(Option.isSome(kept) ? 1 : 0);
      const taken = yield* Effect.forEach(Option.isSome(kept) ? starts : [], (seq) =>
        takenAmong({
          threadId,
          preferred: preferredDisplayId(threadId, seq, Arr.getUnsafe(messages, seq)),
        }),
      );
      const ids = displayIds({
        threadId,
        messages,
        starts,
        taken: taken.flat().map((row) => row.display_id),
      });
      const rows = Arr.zip(starts, ids).map(([seq, displayId], index) => ({
        thread_id: threadId,
        seq: next + index,
        display_id: displayId,
        first_message_seq: seq,
      }));
      // Iterable's chunksOf reads the rows once; its pieces are never empty, as insert needs.
      yield* Effect.forEach(
        EffectIterable.filter(EffectIterable.chunksOf(rows, rowsPerInsert), Arr.isArrayNonEmpty),
        (chunk) => sql`INSERT INTO chat_thread_display_messages ${sql.insert(chunk)}`,
        { discard: true },
      );
      yield* sql`
        UPDATE chat_threads SET display_revision = revision, display_format = ${displayFormat}
        WHERE thread_id = ${threadId}`;
    });

  const notCurrent = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: Schema.Struct({ thread_id: Schema.String }),
    execute: (threadId) => sql`
      SELECT thread_id FROM chat_threads
      WHERE (${threadId} IS NULL OR thread_id = ${threadId})
        AND (display_format IS NOT ${displayFormat} OR display_revision IS NOT revision)`,
  });

  /** What grouping reads of each message, without decoding the messages. */
  const identities = SqlSchema.findAll({
    Request: Schema.String,
    Result: IdentityRow,
    execute: (threadId) => sql`
      SELECT seq, json_extract(message, '$.role') AS role, json_extract(message, '$.id') AS id
      FROM chat_thread_messages WHERE thread_id = ${threadId} ORDER BY seq`,
  });

  /**
   * Builds again the shown messages of the thread. Messages whose positions skip one are left
   * without pages, as are ones without a role.
   */
  const rebuild = (threadId: string) =>
    sql.withTransaction(
      Effect.flatMap(identities(threadId), (rows) =>
        Effect.when(
          rewrite(
            threadId,
            rows.map(({ role, id }) => ({ role, ...optionalProperty("id", id ?? undefined) })),
            0,
          ),
          Effect.succeed(rows.every((row, index) => row.seq === index)),
        ),
      ),
    );

  const currentRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ is_current: Schema.Literals([0, 1]) }),
    execute: (threadId) => sql`
      SELECT display_format IS ${displayFormat} AND display_revision IS revision AS is_current
      FROM chat_threads WHERE thread_id = ${threadId}`,
  });

  return {
    /** Whether the saved thread's shown messages are those of its transcript as it stands. */
    isCurrent: (threadId: string) =>
      Effect.map(currentRow(threadId), ({ is_current }) => is_current === 1),
    rewrite,
    /**
     * Builds the shown messages of every thread, or of `threadId`, that has none current: at
     * startup and after an import, never on a page read. A thread whose messages are not stored
     * ones stays without pages and does not stop the others.
     */
    prepare: (threadId?: string) =>
      Effect.flatMap(notCurrent(threadId ?? null), (threads) =>
        Effect.forEach(
          threads,
          ({ thread_id }) =>
            rebuild(thread_id).pipe(Effect.catchTag("SchemaError", () => Effect.void)),
          { discard: true },
        ),
      ),
  };
});
