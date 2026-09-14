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
import { serverRestartedCode } from "../agent/run-state.ts";
import { sqliteChatPersistence } from "./persistence.ts";

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;

  // A session recorded before chat state existed opens with the transcript rebuilt from its nodes.
  const persistence = sqliteChatPersistence(sqlite, (threadId) =>
    convertMessagesToModelMessages(sessionMessages(nodes.session(threadId), attachments.forNode)),
  );

  // One process owns the database, so a run still marked running was cut off by a restart. It is
  // not resumed or rerun on its own (R10): it is recorded as failed and the user decides.
  sqlite
    .prepare(
      "UPDATE chat_runs SET status = 'failed', finished_at = ?, error = ?, error_code = ? WHERE status = 'running'",
    )
    .run(Date.now(), "The server stopped before this answer finished.", serverRestartedCode);

  /**
   * A cancelled or failed run has no finish to save its transcript, and the answer it was writing
   * may not have reached the messages yet. Saves the messages with that answer in them.
   */
  const keepPartialAnswer = async (ctx: ChatMiddlewareContext) => {
    const answer = ctx.accumulatedContent;
    if (answer.length === 0) return;
    const turnStart = ctx.messages.findLastIndex((message) => message.role === "user");
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
