import {
  convertMessagesToModelMessages,
  type ChatMiddleware,
  type ChatMiddlewareContext,
} from "@tanstack/ai";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { Context, Effect, Layer } from "effect";
import { sessionMessages } from "../agent/history.ts";
import { Attachments } from "../attachments/attachments.ts";
import { messageText } from "../codex/history.ts";
import { Database } from "../db/database.ts";
import { Nodes } from "../memory/nodes.ts";
import { interruptContinuationLostCode, serverRestartedCode } from "../agent/run-state.ts";
import { sqliteChatPersistence } from "./persistence.ts";

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;

  // A session recorded before chat state existed opens with the transcript rebuilt from its nodes.
  const persistence = sqliteChatPersistence(sqlite, (threadId) =>
    convertMessagesToModelMessages(sessionMessages(nodes.session(threadId), attachments.forNode)),
  );

  // One process owns the database, so running and approval-interrupted runs belonged to the old
  // process after a restart. The provider continuation they depended on is gone: leaving their
  // interrupts pending makes a reloaded page offer an approval that can only fail. Retire the
  // interrupts and runs together, then let the user decide whether to send the request again (R10).
  const restartedAt = Date.now();
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite
      .prepare(
        `UPDATE chat_interrupts
         SET status = 'cancelled', resolved_at = ?
         WHERE status = 'pending' AND run_id IN (
           SELECT run_id FROM chat_runs WHERE status IN ('running', 'interrupted')
         )`,
      )
      .run(restartedAt);
    sqlite
      .prepare(
        `UPDATE chat_runs
         SET status = 'failed', finished_at = ?, error = ?, error_code = ?
         WHERE status IN ('running', 'interrupted')`,
      )
      .run(restartedAt, "The server stopped before this answer finished.", serverRestartedCode);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }

  /**
   * A cancelled or failed run has no finish to save its transcript, and the answer it was writing
   * may not have reached the messages yet. Saves the messages with that answer in them.
   */
  const keepPartialAnswer = async (ctx: ChatMiddlewareContext) => {
    const answer = ctx.accumulatedContent;
    if (answer.length === 0) return;
    const turnStart = ctx.messages.map((message) => message.role).lastIndexOf("user");
    const inMessages = ctx.messages
      .slice(turnStart + 1)
      .some((message) => message.role === "assistant" && messageText(message) === answer);
    await persistence.stores.messages.saveThread(
      ctx.threadId,
      inMessages ? [...ctx.messages] : [...ctx.messages, { role: "assistant", content: answer }],
    );
  };

  return {
    persistence,

    /**
     * Saves each run's transcript, run record and pending approvals as the run goes. The answer
     * being written is saved too (every second, and at once when the run is cancelled or fails),
     * so a reload after a cancel or a restart shows what the user had already seen.
     */
    middleware: (): ChatMiddleware[] => [
      withPersistence(persistence, { snapshotStreaming: true }),
      {
        name: "memory-agent/partial-answer",
        onAbort: keepPartialAnswer,
        onError: keepPartialAnswer,
      },
    ],

    /**
     * The `GET` a reloaded page hydrates from: transcript, a still-running run to rejoin, and
     * pending approvals to show again. Only the session's own thread may be read.
     */
    hydrate: (request: Request, sessionId: string) =>
      reconstructChat(persistence, request, {
        authorize: async (threadId) => threadId === sessionId,
      }),

    /** The run record, when it belongs to the session. */
    run: async (sessionId: string, runId: string) => {
      const run = await persistence.stores.runs.get(runId);
      return run?.threadId === sessionId ? run : null;
    },

    /**
     * Retires approvals that the browser can still display after their server-side continuation
     * was lost. This is explicit rather than automatic: abandoning an approval must never be
     * mistaken for approving and executing the gated tool.
     */
    discardPendingInterrupts: async (sessionId: string) => {
      const pending = await persistence.stores.interrupts.listPending(sessionId);
      if (pending.length === 0) return 0;
      const discardedAt = Date.now();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        sqlite
          .prepare(
            `UPDATE chat_interrupts
             SET status = 'cancelled', resolved_at = ?
             WHERE thread_id = ? AND status = 'pending'`,
          )
          .run(discardedAt, sessionId);
        sqlite
          .prepare(
            `UPDATE chat_runs
             SET status = 'failed', finished_at = ?, error = ?, error_code = ?
             WHERE thread_id = ? AND status IN ('running', 'interrupted')`,
          )
          .run(
            discardedAt,
            "The approval continuation was no longer available, so the request was discarded.",
            interruptContinuationLostCode,
            sessionId,
          );
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return pending.length;
    },

    /** The session's most recent run, if any. */
    lastRun: async (sessionId: string) =>
      (await persistence.stores.runs.listByThread?.(sessionId))?.at(-1) ?? null,
  };
});

/**
 * Server-authoritative chat state (TanStack AI persistence) keyed by session id. It is what makes
 * a reload show the same conversation and the same pending approval card.
 */
export class ChatState extends Context.Tag("memory-agent/ChatState")<
  ChatState,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(ChatState, make);
}
