import { Effect, Schema } from "effect";
import { sqlGet, sqlRun } from "./sql.ts";

/**
 * Stores a thread's transcript, given as its JSON array text, the way a writer other than
 * `RunStore` does: the thread's rows only, every message written again, without its history pages.
 */
export const writeThread = ({
  threadId,
  messages,
  updatedAt = 1,
}: {
  readonly threadId: string;
  readonly messages: string;
  readonly updatedAt?: number;
}) =>
  sqlRun(
    `INSERT INTO chat_threads (thread_id, updated_at) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`,
    threadId,
    updatedAt,
  ).pipe(
    Effect.andThen(sqlRun("DELETE FROM chat_thread_messages WHERE thread_id = ?", threadId)),
    Effect.andThen(
      sqlRun(
        `INSERT INTO chat_thread_messages (thread_id, seq, message)
          SELECT ?, key, value FROM json_each(?)`,
        threadId,
        messages,
      ),
    ),
  );

const decodeText = Schema.decodeUnknownEffect(Schema.Struct({ messages: Schema.String }));
const decodeRevision = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Int }));

/** The thread's stored transcript as one JSON array text, its messages in order. */
export const threadText = (threadId: string) =>
  sqlGet(
    `SELECT '[' || COALESCE(group_concat(message, ',' ORDER BY seq), '') || ']' AS messages
      FROM chat_thread_messages WHERE thread_id = ?`,
    threadId,
  ).pipe(
    Effect.flatMap(decodeText),
    Effect.map(({ messages }) => messages),
    Effect.orDie,
  );

/** The revision the thread's last change gave it. */
export const threadRevision = (threadId: string) =>
  sqlGet("SELECT revision FROM chat_threads WHERE thread_id = ?", threadId).pipe(
    Effect.flatMap(decodeRevision),
    Effect.map(({ revision }) => revision),
    Effect.orDie,
  );
