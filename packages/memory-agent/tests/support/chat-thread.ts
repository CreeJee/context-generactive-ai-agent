import { Effect, Schema } from "effect";
import { sqlGet, sqlRun } from "./sql.ts";

/**
 * Stores a thread's transcript, given as its JSON text, the way a writer other than `RunStore`
 * does: the thread's rows only, without its history pages.
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
    `INSERT INTO chat_threads (thread_id, messages, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE
      SET messages = excluded.messages, updated_at = excluded.updated_at`,
    threadId,
    messages,
    updatedAt,
  );

const decodeText = Schema.decodeUnknownEffect(Schema.Struct({ messages: Schema.String }));
const decodeRevision = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Int }));

/** The thread's stored transcript as JSON text. */
export const threadText = (threadId: string) =>
  sqlGet("SELECT messages FROM chat_threads WHERE thread_id = ?", threadId).pipe(
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
