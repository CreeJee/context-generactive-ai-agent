import {
  Array as Arr,
  Effect,
  Function as EffectFunction,
  Iterable as EffectIterable,
  Option,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { StoredMessage } from "./schema.ts";

/**
 * A thread's transcript as `chat_thread_messages` keeps it: one row per message, `seq` numbering
 * them in order from 0. Joined in order, the rows' JSON texts are the transcript's JSON array.
 */

/** A row of a thread read: its revision, beside one message; a thread with none has one row. */
const StoredRow = Schema.Struct({ revision: Schema.Int, message: Schema.NullOr(Schema.String) });

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(StoredMessage));
const sameMessage = Schema.toEquivalence(StoredMessage);

/** Rows written per statement, far below SQLite's limit on bound values. */
const rowsPerInsert = 500;

/**
 * Where `next` first differs from `stored`: the first message to write. It is `next.length` when
 * `stored` starts with all of `next`, and the rows from there on are the ones to remove.
 */
export const firstChange: {
  (next: ReadonlyArray<StoredMessage>): (stored: ReadonlyArray<StoredMessage>) => number;
  (stored: ReadonlyArray<StoredMessage>, next: ReadonlyArray<StoredMessage>): number;
} = EffectFunction.dual(
  2,
  (stored: ReadonlyArray<StoredMessage>, next: ReadonlyArray<StoredMessage>) =>
    Option.getOrElse(
      Arr.findFirstIndex(
        next,
        (message, seq) =>
          !Option.exists(
            Arr.get(stored, seq),
            (kept) => kept === message || sameMessage(kept, message),
          ),
      ),
      () => next.length,
    ),
);

/** Reads and writes threads' message rows, on the app's SqlClient. */
export const threadMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The messages come in `seq` order straight from the primary key. Joining them into one text in
  // SQL (`group_concat(... ORDER BY seq)`) sorted the whole transcript in a temporary B-tree first
  // and copied it into one string: about half a second for a 50 MB thread.
  const storedRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredRow,
    execute: (threadId) => sql`
      SELECT t.revision, m.message FROM chat_threads AS t
      LEFT JOIN chat_thread_messages AS m ON m.thread_id = t.thread_id
      WHERE t.thread_id = ${threadId} ORDER BY m.seq`,
  });
  return {
    /**
     * The thread's revision and its messages' JSON texts in order, in one statement: the messages
     * are the ones at that revision. None when the thread was never saved.
     */
    stored: (threadId: string) =>
      Effect.map(storedRows(threadId), (rows) =>
        Option.map(Arr.head(rows), ({ revision }) => ({
          revision,
          messages: Arr.flatMapNullishOr(rows, ({ message }) => message),
        })),
      ),
    /** Removes the thread's messages from `seq` on. */
    removeFrom: (threadId: string, seq: number) =>
      Effect.asVoid(
        sql`DELETE FROM chat_thread_messages WHERE thread_id = ${threadId} AND seq >= ${seq}`,
      ),
    /**
     * Writes `messages` as the thread's messages from `seq` on, where it has none. Gives the JSON
     * texts it wrote, in order.
     */
    insertFrom: (threadId: string, seq: number, messages: ReadonlyArray<StoredMessage>) =>
      Effect.forEach(messages, (message) => encodeMessage(message)).pipe(
        Effect.tap((texts) =>
          // Iterable's chunksOf reads the rows once; its pieces are never empty, as insert needs.
          Effect.forEach(
            EffectIterable.filter(
              EffectIterable.chunksOf(
                texts.map((message, index) => ({ thread_id: threadId, seq: seq + index, message })),
                rowsPerInsert,
              ),
              Arr.isArrayNonEmpty,
            ),
            (chunk) => sql`INSERT INTO chat_thread_messages ${sql.insert(chunk)}`,
            { discard: true },
          ),
        ),
      ),
  };
});
