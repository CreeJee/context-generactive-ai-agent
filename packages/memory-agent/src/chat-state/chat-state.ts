import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import {
  convertMessagesToModelMessages,
  type ChatMiddleware,
  type ChatMiddlewareContext,
  type ModelMessage,
} from "@tanstack/ai";
import { reconstructChat, withPersistence, type MessagePage } from "@tanstack/ai-persistence";
import { Clock, Context, Effect, Layer, MutableHashMap, Option } from "effect";
import type { Attachment } from "../attachments/attachments.ts";
import { sessionMessages } from "../agent/history.ts";
import { Attachments } from "../attachments/attachments.ts";
import { messageText } from "../messages/text.ts";
import { SqlClient } from "effect/sql";
import { Nodes } from "../memory/nodes.ts";
import {
  interruptContinuationLostCode,
  serverRestartedCode,
  serverRestartedMessage,
} from "../agent/run-state.ts";
import {
  latestChatRun,
  migrateLegacyChatThreads,
  migrateMissingChatThread,
  ownedChatPersistence,
} from "./persistence.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;

  // Sessions recorded before chat state existed are migrated once from their durable evidence.
  // This keeps provider migration independent of any provider-side conversation state.
  const fallbackThread = (threadId: string) =>
    Effect.gen(function* () {
      const session = yield* nodes.session(threadId);
      // Read the images first: the transcript is built in one synchronous pass.
      const images = MutableHashMap.fromIterable(
        yield* Effect.forEach(
          session.filter((node) => node.kind === "user"),
          (node) =>
            Effect.map(
              attachments.forNode(node.id),
              (found): readonly [string, readonly Attachment[]] => [node.id, found],
            ),
        ),
      );
      return convertMessagesToModelMessages(
        sessionMessages(session, (nodeId) =>
          Option.getOrElse(MutableHashMap.get(images, nodeId), () => []),
        ),
      );
    });
  yield* migrateLegacyChatThreads(fallbackThread);
  const persistence = yield* ownedChatPersistence;
  const lastRun = yield* latestChatRun();

  // Reconstruction otherwise gives id-less stored messages random IDs on every GET. Use the
  // central store's existing full-thread index IDs for both paged and unpaged hydration. Keep
  // persisted SDK IDs (including assistant segments) untouched so their live-stream identity
  // survives. This is a read-only view: no transcript rewrite, provider input or SSE ID changes.
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadHydrationThread(threadId: string): Promise<ModelMessage[]>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadHydrationThread(
    threadId: string,
    options: { limit?: number; before?: string },
  ): Promise<ModelMessage[] | MessagePage>;
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  function loadHydrationThread(threadId: string, options?: { limit?: number; before?: string }) {
    if (options?.limit !== undefined)
      return persistence.stores.messages.loadThread(threadId, options);
    return runNativeEffect(
      nativePromise(() => persistence.stores.messages.loadThread(threadId)).pipe(
        Effect.map((stored) =>
          stored.map((message, index) =>
            message.id === undefined ? { ...message, id: `stored:${threadId}:${index}` } : message,
          ),
        ),
      ),
    );
  }
  const hydrationPersistence = {
    ...persistence,
    stores: {
      ...persistence.stores,
      messages: { ...persistence.stores.messages, loadThread: loadHydrationThread },
    },
  };

  // One process owns the database, so running and approval-interrupted runs belonged to the old
  // process after a restart. The provider continuation they depended on is gone: leaving their
  // interrupts pending makes a reloaded page offer an approval that can only fail. Retire the
  // interrupts and runs together, then let the user decide whether to send the request again (R10).
  const restartedAt = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.andThen(
      sql`
        UPDATE chat_interrupts
        SET status = 'cancelled', resolved_at = ${restartedAt}
        WHERE status = 'pending' AND run_id IN (
          SELECT run_id FROM chat_runs WHERE status IN ('running', 'interrupted')
        )`,
      sql`
        UPDATE chat_runs
        SET status = 'failed', finished_at = ${restartedAt},
            error = ${serverRestartedMessage},
            error_code = ${serverRestartedCode}
        WHERE status IN ('running', 'interrupted')`,
    ),
  );

  /**
   * A cancelled or failed run has no finish to save its transcript, and the answer it was writing
   * may not have reached the messages yet. Saves the messages with that answer in them.
   */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const keepPartialAnswer = Effect.fn("ChatState.keepPartialAnswer")(function* (
    ctx: ChatMiddlewareContext,
  ) {
    const answer = ctx.accumulatedContent;
    if (answer.length === 0) return;
    const turnStart = ctx.messages.map((message) => message.role).lastIndexOf("user");
    const inMessages = ctx.messages
      .slice(turnStart + 1)
      .some((message) => message.role === "assistant" && messageText(message) === answer);
    yield* nativePromise(() =>
      persistence.stores.messages.saveThread(
        ctx.threadId,
        inMessages ? [...ctx.messages] : [...ctx.messages, { role: "assistant", content: answer }],
      ),
    );
  });

  return {
    persistence,

    /**
     * Saves each run's transcript, run record and pending approvals as the run goes. The answer
     * being written is saved too (every second, and at once when the run is cancelled or fails),
     * so a reload after a cancel or a restart shows what the user had already seen.
     */
    middleware: (signal?: AbortSignal): ChatMiddleware[] => [
      withPersistence(persistence, { snapshotStreaming: true }),
      {
        name: "memory-agent/partial-answer",
        // SDK persistence records ordinary cancellation as aborted; owner shutdown is a restart failure.
        onAbort(ctx) {
          return runNativeEffect(
            Effect.gen(function* () {
              yield* keepPartialAnswer(ctx);
              if (signal?.reason === "service_shutdown")
                yield* sql`
                  UPDATE chat_runs
                  SET status = 'failed', finished_at = ${yield* Clock.currentTimeMillis},
                      error = ${serverRestartedMessage},
                      error_code = ${serverRestartedCode}
                  WHERE run_id = ${ctx.runId} AND status = 'aborted'`;
            }),
          );
        },
        onError: (ctx) => runNativeEffect(keepPartialAnswer(ctx)),
      },
    ],

    /**
     * The `GET` a reloaded page hydrates from: transcript, a still-running run to rejoin, and
     * pending approvals to show again. Only the session's own thread may be read.
     */
    hydrate: (request: Request, sessionId: string) =>
      Effect.gen(function* () {
        // Imports may create sessions after this service's startup migration has already run.
        if (yield* migrateMissingChatThread(sessionId, fallbackThread))
          yield* persistence.prepareThread(sessionId);
        return yield* nativePromise(() =>
          reconstructChat(hydrationPersistence, request, {
            // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
            authorize: (threadId) => Promise.resolve(threadId === sessionId),
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),

    /** The run record, when it belongs to the session. */
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    run: (sessionId: string, runId: string) =>
      runNativeEffect(
        nativePromise(() => persistence.stores.runs.get(runId)).pipe(
          Effect.map((run) => (run?.threadId === sessionId ? run : null)),
        ),
      ),

    /**
     * Retires approvals that the browser can still display after their server-side continuation
     * was lost. This is explicit rather than automatic: abandoning an approval must never be
     * mistaken for approving and executing the gated tool.
     */
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    discardPendingInterrupts: (sessionId: string) =>
      runNativeEffect(
        Effect.gen(function* () {
          const pending = yield* nativePromise(() =>
            persistence.stores.interrupts.listPending(sessionId),
          );
          if (pending.length === 0) return 0;
          const discardedAt = yield* Clock.currentTimeMillis;
          yield* sql.withTransaction(
            Effect.andThen(
              sql`
                UPDATE chat_interrupts
                SET status = 'cancelled', resolved_at = ${discardedAt}
                WHERE thread_id = ${sessionId} AND status = 'pending'`,
              sql`
                UPDATE chat_runs
                SET status = 'failed', finished_at = ${discardedAt},
                    error = 'The approval continuation was no longer available, so the request was discarded.',
                    error_code = ${interruptContinuationLostCode}
                WHERE thread_id = ${sessionId} AND status IN ('running', 'interrupted')`,
            ),
          );
          return pending.length;
        }),
      ),

    /** The session's most recent run, if any. */
    lastRun,
  };
});

/**
 * Server-authoritative chat state (TanStack AI persistence) keyed by session id. It is what makes
 * a reload show the same conversation and the same pending approval card.
 */
export class ChatState extends Context.Service<ChatState, Effect.Success<typeof make>>()(
  "memory-agent/chat-state/chat-state/ChatState",
) {
  static readonly layer = Layer.effect(ChatState, make);
}
