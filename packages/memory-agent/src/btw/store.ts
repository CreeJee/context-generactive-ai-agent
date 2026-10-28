import {
  Array as Arr,
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Attachments } from "../attachments/attachments.ts";
import { StoredMessage, StoredUserMessage, TextPart } from "../chat-store/schema.ts";
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

/** `btw_threads.messages`: the thread's messages as the run loop stores a conversation. */
const Messages = Schema.fromJsonString(Schema.Array(StoredMessage));

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
  const crypto = yield* Crypto.Crypto;

  const selectThread = sql.literal(`SELECT t.*, s.project_id FROM btw_threads t
    JOIN sessions s ON s.id = t.parent_session_id`);
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
    execute: (threadId) => sql`SELECT messages FROM btw_threads WHERE id = ${threadId}`,
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

    /** Saves the thread's messages. An answer still finishing never brings a deleted thread back. */
    saveMessages: Effect.fn("BtwThreads.saveMessages")(function* (
      threadId: string,
      messages: ReadonlyArray<StoredMessage>,
    ) {
      const text = yield* Schema.encodeEffect(Messages)(
        messages.filter((message) => !isEmptyUserText(message)),
      );
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE btw_threads SET messages = ${text}, updated_at = ${updatedAt}
        WHERE id = ${threadId}`;
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
        const id = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(() =>
              BtwError.make({ reason: BtwStorageFailed.make({ operation: "create_thread" }) }),
            ),
          );
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
      attachmentIds.length === 0
        ? Effect.void
        : Effect.asVoid(sql`
            INSERT OR IGNORE INTO btw_attachments ${sql.insert(
              attachmentIds.map((attachmentId) => ({
                thread_id: threadId,
                attachment_id: attachmentId,
              })),
            )}`),

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
