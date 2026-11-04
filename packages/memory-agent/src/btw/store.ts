import { Array as Arr, Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlSchema } from "effect/sql";
import { Attachments } from "../attachments/attachments.ts";
import { StoredMessage, StoredUserMessage, TextPart } from "../chat-store/schema.ts";
import { firstChange } from "../chat-store/thread-messages.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { Sessions } from "../sessions/sessions.ts";
import { firstMessageTitle } from "../sessions/title.ts";
import {
  BtwError,
  BtwParentNotFound,
  BtwStorageFailed,
  BtwThreadNotFound,
  type BtwThread,
} from "./contracts.ts";

/** A thread's `btw_thread_messages` rows joined in order: its messages as the run loop stores them. */
const Messages = Schema.fromJsonString(Schema.Array(StoredMessage));
const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(StoredMessage));
/** The JSON array of the messages of thread `t`. */
const messagesOf = `'[' || coalesce((SELECT group_concat(m.message, ',' ORDER BY m.seq)
  FROM btw_thread_messages m WHERE m.thread_id = t.id), '') || ']'`;

const ThreadRow = Schema.Struct({
  id: Schema.String,
  parent_session_id: Schema.String,
  project_id: Schema.String,
  messages: Messages,
  created_at: Schema.String,
  updated_at: Schema.Finite,
});

const isQuestion = Schema.is(StoredUserMessage);
const isText = Schema.is(Schema.String);
const isTextPart = Schema.is(TextPart);

/** A question's text; its images are left out. */
const questionText = ({ content }: typeof StoredUserMessage.Type) =>
  isText(content)
    ? content
    : content
        .filter(isTextPart)
        .map((part) => part.content)
        .join("");

function toThread(decoded: typeof ThreadRow.Type): BtwThread {
  return {
    id: decoded.id,
    parentSessionId: decoded.parent_session_id,
    projectId: decoded.project_id,
    title: Option.getOrNull(
      Option.map(Arr.findFirst(decoded.messages, isQuestion), (question) =>
        firstMessageTitle(questionText(question)),
      ),
    ),
    createdAt: decoded.created_at,
    updatedAt: decoded.updated_at,
  };
}

const threadNotFound = (threadId: string) =>
  BtwError.make({ reason: BtwThreadNotFound.make({ threadId }) });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* Sessions;
  const attachments = yield* Attachments;
  const crypto = yield* SecureRandom.SecureRandom;

  const selectThread = sql.literal(`SELECT t.id, t.parent_session_id, t.created_at, t.updated_at,
      s.project_id, ${messagesOf} AS messages
    FROM btw_threads t JOIN sessions s ON s.id = t.parent_session_id`);
  const getRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (threadId) => sql`${selectThread} WHERE t.id = ${threadId}`,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (parentSessionId) => sql`
      ${selectThread} WHERE t.parent_session_id = ${parentSessionId}
      ORDER BY t.created_at DESC, t.id`,
  });
  const selectMessages = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ messages: Messages }),
    execute: (threadId) =>
      sql`SELECT ${sql.literal(messagesOf)} AS messages FROM btw_threads t WHERE t.id = ${threadId}`,
  });

  const get = (threadId: string) =>
    Effect.flatMap(
      getRow(threadId),
      Option.match({
        onNone: () => Effect.fail(threadNotFound(threadId)),
        onSome: (row) => Effect.succeed(toThread(row)),
      }),
    );

  return {
    get,

    /** The thread's messages; a deleted thread has none. */
    messages: (threadId: string) =>
      Effect.map(
        selectMessages(threadId),
        Option.match({ onNone: () => [], onSome: (row) => row.messages }),
      ),

    /**
     * Saves the thread's messages, rewriting them from the first that changed. An answer still
     * finishing never brings a deleted thread back.
     */
    saveMessages: Effect.fn("BtwThreads.saveMessages")(function* (
      threadId: string,
      messages: ReadonlyArray<StoredMessage>,
    ) {
      const next = messages.filter((message) => !isEmptyUserText(message));
      const updatedAt = yield* Clock.currentTimeMillis;
      const write = (stored: ReadonlyArray<StoredMessage>) => {
        const from = firstChange(stored, next);
        return sql`DELETE FROM btw_thread_messages WHERE thread_id = ${threadId} AND seq >= ${from}`.pipe(
          Effect.andThen(
            Effect.forEach(
              next.slice(from),
              (message, index) =>
                Effect.flatMap(
                  encodeMessage(message),
                  (text) => sql`INSERT INTO btw_thread_messages (thread_id, seq, message)
                    VALUES (${threadId}, ${from + index}, ${text})`,
                ),
              { discard: true },
            ),
          ),
          Effect.andThen(
            sql`UPDATE btw_threads SET updated_at = ${updatedAt} WHERE id = ${threadId}`,
          ),
        );
      };
      yield* sql.withTransaction(
        Effect.flatMap(
          selectMessages(threadId),
          Option.match({ onNone: () => Effect.void, onSome: (row) => write(row.messages) }),
        ),
      );
    }),

    /** Opens a BTW thread under an existing main conversation. Its binding never changes. */
    create: (parentSessionId: string) =>
      Effect.gen(function* () {
        yield* sessions
          .get(parentSessionId)
          .pipe(
            Effect.catchTag("SessionNotFound", () =>
              Effect.fail(
                BtwError.make({ reason: BtwParentNotFound.make({ sessionId: parentSessionId }) }),
              ),
            ),
          );
        const id = yield* crypto.uuidV4();
        const createdAt = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO btw_threads (id, parent_session_id, created_at, updated_at)
          VALUES (${id}, ${parentSessionId}, ${DateTime.formatIso(DateTime.makeUnsafe(createdAt))},
            ${createdAt})`;
        return yield* get(id);
      }),

    /** The main conversation's BTW threads, newest first. */
    list: (parentSessionId: string) =>
      Effect.map(listRows(parentSessionId), (rows) => rows.map(toThread)),

    /** Keeps the images a BTW message carried until the thread is deleted. */
    link: (threadId: string, attachmentIds: readonly string[]) =>
      Arr.match(attachmentIds, {
        onEmpty: () => Effect.void,
        onNonEmpty: (carried) =>
          Effect.asVoid(sql`
            INSERT OR IGNORE INTO btw_attachments ${sql.insert(
              Arr.map(carried, (attachmentId) => ({
                thread_id: threadId,
                attachment_id: attachmentId,
              })),
            )}`),
      }),

    /**
     * Removes the thread with its messages, tool calls and results and attachment links in one
     * transaction, then the image files no message references any more. A failed file cleanup
     * leaves only unreferenced blobs, which the next orphan purge removes.
     */
    remove: (threadId: string) =>
      Effect.gen(function* () {
        const deleted = yield* sql`DELETE FROM btw_threads WHERE id = ${threadId} RETURNING id`;
        yield* Effect.when(
          Effect.fail(threadNotFound(threadId)),
          Effect.succeed(deleted.length === 0),
        );
        yield* attachments.purgeOrphans.pipe(
          Effect.mapError(() =>
            BtwError.make({ reason: BtwStorageFailed.make({ operation: "purge_attachments" }) }),
          ),
        );
      }),
  };
});

/** BTW threads: stored for reopening, kept apart from nodes, search and interpretation. */
export class BtwThreads extends Context.Service<BtwThreads, Effect.Success<typeof make>>()(
  "memory-agent/btw/store/BtwThreads",
) {
  static readonly layer = Layer.effect(BtwThreads, make);
}
