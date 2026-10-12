import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { ModelMessage } from "@tanstack/ai";
import {
  defineAIPersistence,
  defineMessageStore,
  type MessagePage,
} from "@tanstack/ai-persistence";
import { Context, Effect, Layer, Schema } from "effect";
import { Attachments } from "../attachments/attachments.ts";
import { storePromise } from "../chat-state/persistence.ts";
import { Database } from "../db/database.ts";
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
const decodeThreadRow = Schema.decodeUnknownSync(ThreadRow);
const MessagesRow = Schema.Struct({ messages: Schema.String });
const decodeMessagesRow = Schema.decodeUnknownSync(MessagesRow);

// Stored JSON was written by this store from the same TanStack types, so parsing restores them.
const parseMessages = (text: string): ModelMessage[] => JSON.parse(text);

function toThread(row: Record<string, SQLOutputValue>): BtwThread {
  const decoded = decodeThreadRow(row);
  const firstQuestion = parseMessages(decoded.messages).find((message) => message.role === "user");
  return {
    id: decoded.id,
    parentSessionId: decoded.parent_session_id,
    projectId: decoded.project_id,
    title: firstQuestion ? firstMessageTitle(messageText(firstQuestion)) : null,
    createdAt: decoded.created_at,
    updatedAt: decoded.updated_at,
  };
}

const threadNotFound = (threadId: string) =>
  new BtwError({ reason: new BtwThreadNotFound({ threadId }) });

const selectThread = `SELECT t.*, s.project_id FROM btw_threads t
  JOIN sessions s ON s.id = t.parent_session_id`;

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const sessions = yield* Sessions;
  const attachments = yield* Attachments;

  const getRow = sqlite.prepare(`${selectThread} WHERE t.id = ?`);
  const selectMessages = sqlite.prepare("SELECT messages FROM btw_threads WHERE id = ?");
  // An UPDATE, never an upsert: a run still finishing cannot bring a deleted thread back.
  const updateMessages = sqlite.prepare(
    "UPDATE btw_threads SET messages = ?, updated_at = ? WHERE id = ?",
  );

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string): Promise<ModelMessage[]>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(
    threadId: string,
    options: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadThread(threadId: string, options?: { limit?: number; before?: string }) {
    return storePromise(() => {
      const row = selectMessages.get(threadId);
      const stored = row ? parseMessages(decodeMessagesRow(row).messages) : [];
      if (options?.limit === undefined) return stored;
      const messages = stored.map((message, index) =>
        message.id === undefined ? { ...message, id: `btw:${threadId}:${index}` } : message,
      );
      const end =
        options.before === undefined
          ? messages.length
          : messages.findIndex((message) => message.id === options.before);
      return { messages: end < 0 ? [] : messages.slice(0, end), truncated: false };
    });
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
          return storePromise(() => {
            updateMessages.run(
              JSON.stringify(next.filter((message) => !isEmptyUserText(message))),
              Date.now(),
              threadId,
            );
          });
        },
      }),
    },
  });

  const get = (threadId: string) =>
    Effect.suspend(() => {
      const row = getRow.get(threadId);
      return row ? Effect.succeed(toThread(row)) : Effect.fail(threadNotFound(threadId));
    });

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
                new BtwError({ reason: new BtwParentNotFound({ sessionId: parentSessionId }) }),
              ),
            ),
          );
        const id = randomUUID();
        sqlite
          .prepare(
            "INSERT INTO btw_threads (id, parent_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(id, parentSessionId, new Date().toISOString(), Date.now());
        return yield* get(id);
      }),

    /** The main conversation's BTW threads, newest first. */
    list: (parentSessionId: string) =>
      Effect.sync(() =>
        sqlite
          .prepare(`${selectThread} WHERE t.parent_session_id = ? ORDER BY t.created_at DESC, t.id`)
          .all(parentSessionId)
          .map(toThread),
      ),

    /** Keeps the images a BTW message carried until the thread is deleted. */
    link: (threadId: string, attachmentIds: readonly string[]) =>
      Effect.sync(() => {
        const insert = sqlite.prepare(
          "INSERT OR IGNORE INTO btw_attachments (thread_id, attachment_id) VALUES (?, ?)",
        );
        atomic(() => {
          for (const attachmentId of attachmentIds) insert.run(threadId, attachmentId);
        });
      }),

    /**
     * Removes the thread with its messages, tool calls and results and attachment links in one
     * transaction, then the image files no message references any more. A failed file cleanup
     * leaves only unreferenced blobs, which the next orphan purge removes.
     */
    remove: (threadId: string) =>
      Effect.gen(function* () {
        const deleted = sqlite.prepare("DELETE FROM btw_threads WHERE id = ?").run(threadId);
        if (deleted.changes === 0) return yield* threadNotFound(threadId);
        yield* attachments.purgeOrphans.pipe(
          Effect.mapError(
            () =>
              new BtwError({ reason: new BtwStorageFailed({ operation: "purge_attachments" }) }),
          ),
        );
      }),
  };
});

/** BTW threads: stored for reopening, kept apart from nodes, search and interpretation. */
export class BtwThreads extends Context.Service<BtwThreads, Effect.Success<typeof make>>()(
  "memory-agent/BtwThreads",
) {
  static readonly layer = Layer.effect(BtwThreads, make);
}
