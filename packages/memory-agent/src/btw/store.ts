import type { ModelMessage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineMessageStore,
  type MessagePage,
} from "@tanstack/ai-persistence";
import { Clock, Context, Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { Attachments } from "../attachments/attachments.ts";
import { runNativeEffectWith } from "../runtime/native-effect.ts";
import { isEmptyUserText } from "../messages/empty-user.ts";
import { messageText } from "../messages/text.ts";
import { Sessions } from "../sessions/sessions.ts";
import { firstMessageTitle } from "../sessions/title.ts";
import {
  BtwError,
  BtwParentNotFound,
  BtwStorageFailed,
  BtwThreadNotFound,
  type BtwThread,
} from "./contracts.ts";

const ThreadRow = Schema.Struct({
  id: Schema.String,
  parent_session_id: Schema.String,
  project_id: Schema.String,
  messages: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.Finite,
});

// Stored JSON was written by this store from the same TanStack types, so parsing restores them.
const parseMessages = (text: string): ModelMessage[] => JSON.parse(text);

function toThread(decoded: typeof ThreadRow.Type): BtwThread {
  const firstQuestion = parseMessages(decoded.messages).find((message) => message.role === "user");
  return {
    id: decoded.id,
    parentSessionId: decoded.parent_session_id,
    projectId: decoded.project_id,
    title: firstQuestion !== undefined ? firstMessageTitle(messageText(firstQuestion)) : null,
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
  const run = runNativeEffectWith(yield* Effect.context());

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
    Result: Schema.Struct({ messages: Schema.String }),
    execute: (threadId) => sql`SELECT messages FROM btw_threads WHERE id = ${threadId}`,
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string): Promise<ModelMessage[]>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(
    threadId: string,
    options: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string, options?: { limit?: number; before?: string }) {
    return run(
      Effect.map(selectMessages(threadId), (row) => {
        const stored = Option.match(row, {
          onNone: (): ModelMessage[] => [],
          onSome: ({ messages }) => parseMessages(messages),
        });
        if (options?.limit === undefined) return stored;
        const messages = stored.map((message, index) =>
          message.id === undefined ? { ...message, id: `btw:${threadId}:${index}` } : message,
        );
        const end =
          options.before === undefined
            ? messages.length
            : messages.findIndex((message) => message.id === options.before);
        return { messages: end < 0 ? [] : messages.slice(0, end), truncated: false };
      }),
    );
  }

  /**
   * Transcript-only TanStack persistence. No run, interrupt or metadata store: a BTW run has no
   * approvals to resume and leaves no row outside `btw_threads`.
   */
  const persistence = defineAIPersistence({
    stores: {
      messages: defineMessageStore({
        loadThread,
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        saveThread(threadId, next) {
          const messages = JSON.stringify(next.filter((message) => !isEmptyUserText(message)));
          // An UPDATE, never an upsert: a run still finishing cannot bring a deleted thread back.
          return run(
            Effect.flatMap(Clock.currentTimeMillis, (updatedAt) =>
              Effect.asVoid(sql`
                UPDATE btw_threads SET messages = ${messages}, updated_at = ${updatedAt}
                WHERE id = ${threadId}`),
            ),
          );
        },
      }),
    },
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
    persistence,
    get,

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
        if (deleted.length === 0) return yield* threadNotFound(threadId);
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
