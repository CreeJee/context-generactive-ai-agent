import { convertMessagesToModelMessages } from "@tanstack/ai";
import { Clock, Context, Effect, Layer, MutableHashMap, Option } from "effect";
import type { Attachment } from "../attachments/attachments.ts";
import { sessionMessages } from "../agent/history.ts";
import { Attachments } from "../attachments/attachments.ts";
import { SqlClient } from "effect/sql";
import { Nodes } from "../memory/nodes.ts";
import { serverRestartedCode, serverRestartedMessage } from "../agent/run-state.ts";
import {
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

  /** Imports may create sessions after this service's startup migration has already run. */
  const prepare = (sessionId: string) =>
    Effect.gen(function* () {
      if (yield* migrateMissingChatThread(sessionId, fallbackThread))
        yield* persistence.prepareThread(sessionId);
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  return {
    /** Makes the session's thread and its pages before they are read. */
    prepare,
  };
});

/**
 * Chat state at startup, keyed by session id: threads for sessions recorded before chat state
 * existed, the history pages, and the runs the previous process left unfinished. `RunStore` reads
 * and writes the rows after that.
 */
export class ChatState extends Context.Service<ChatState, Effect.Success<typeof make>>()(
  "memory-agent/chat-state/chat-state/ChatState",
) {
  static readonly layer = Layer.effect(ChatState, make);
}
