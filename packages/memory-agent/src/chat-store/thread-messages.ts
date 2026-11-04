import { Array as Arr, Effect, Function as EffectFunction, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { StoredMessage } from "./schema.ts";

/**
 * A thread's transcript as `chat_thread_messages` keeps it: one row per message, `seq` numbering
 * them in order from 0. Joined in order, the rows' JSON texts are the transcript's JSON array.
 */

const StoredThread = Schema.Struct({ revision: Schema.Int, messages: Schema.String });

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
  return {
    /**
     * The thread's revision and its messages' JSON array text, in one statement: the messages are
     * the ones at that revision. None when the thread was never saved.
     */
    stored: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: StoredThread,
      execute: (threadId) => sql`
        SELECT revision, '[' || COALESCE((
          SELECT group_concat(message, ',' ORDER BY seq) FROM chat_thread_messages AS m
          WHERE m.thread_id = chat_threads.thread_id), '') || ']' AS messages
        FROM chat_threads WHERE thread_id = ${threadId}`,
    }),
    /** Removes the thread's messages from `seq` on. */
    removeFrom: (threadId: string, seq: number) =>
      Effect.asVoid(
        sql`DELETE FROM chat_thread_messages WHERE thread_id = ${threadId} AND seq >= ${seq}`,
      ),
    /** Writes `messages` as the thread's messages from `seq` on, where it has none. */
    insertFrom: (threadId: string, seq: number, messages: ReadonlyArray<StoredMessage>) =>
      Effect.forEach(messages, (message, index) =>
        Effect.map(encodeMessage(message), (text) => ({
          thread_id: threadId,
          seq: seq + index,
          message: text,
        })),
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            Arr.chunksOf(rows, rowsPerInsert),
            (chunk) => sql`INSERT INTO chat_thread_messages ${sql.insert(chunk)}`,
            { discard: true },
          ),
        ),
      ),
  };
});
