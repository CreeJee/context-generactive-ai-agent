import { Clock, Context, Effect, Layer, MutableHashMap, Option, Schema } from "effect";
import type { Attachment } from "../attachments/attachments.ts";
import { sessionMessages } from "../agent/history.ts";
import { Attachments } from "../attachments/attachments.ts";
import { StoredMessage } from "../chat-store/schema.ts";
import { SqlClient, SqlSchema } from "effect/sql";
import { Nodes } from "../memory/nodes.ts";
import { serverRestartedCode, serverRestartedMessage } from "../agent/run-state.ts";
import { historyProjection } from "./history-projection-native.ts";

const MissingThread = Schema.Struct({ id: Schema.String });
const NewThread = Schema.Struct({
  threadId: Schema.String,
  messages: Schema.fromJsonString(Schema.Array(StoredMessage)),
  updatedAt: Schema.Finite,
});

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
      return sessionMessages(session, (nodeId) =>
        Option.getOrElse(MutableHashMap.get(images, nodeId), () => []),
      );
    });

  const missingThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MissingThread,
    execute: () => sql`
      SELECT sessions.id FROM sessions
      LEFT JOIN chat_threads ON chat_threads.thread_id = sessions.id
      WHERE chat_threads.thread_id IS NULL
      ORDER BY sessions.created_at, sessions.id`,
  });
  const missingThread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: MissingThread,
    execute: (id) => sql`
      SELECT sessions.id FROM sessions
      LEFT JOIN chat_threads ON chat_threads.thread_id = sessions.id
      WHERE sessions.id = ${id} AND chat_threads.thread_id IS NULL`,
  });
  const insertThread = SqlSchema.void({
    Request: NewThread,
    execute: (thread) => sql`
      INSERT OR IGNORE INTO chat_threads (thread_id, messages, updated_at)
      VALUES (${thread.threadId}, ${thread.messages}, ${thread.updatedAt})`,
  });
  /** Writes the session's thread as its nodes recorded it. */
  const materialize = (threadId: string, updatedAt: number) =>
    Effect.flatMap(fallbackThread(threadId), (messages) =>
      insertThread({ threadId, messages, updatedAt }),
    );

  // Existing chat threads are authoritative and are never overwritten. The session id remains the
  // thread id, so titles, memory nodes, attachments and URLs keep pointing at the same
  // conversation after the provider runtime migration.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const updatedAt = yield* Clock.currentTimeMillis;
      // Sessions are rebuilt one after another: each reads its own nodes and attachments.
      yield* Effect.forEach(yield* missingThreads(), ({ id }) => materialize(id, updatedAt), {
        discard: true,
      });
    }),
  );
  const projection = yield* historyProjection();
  yield* projection.prepare();

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
    Effect.flatMap(
      missingThread(sessionId),
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ id }) =>
          Effect.flatMap(Clock.currentTimeMillis, (updatedAt) => materialize(id, updatedAt)).pipe(
            Effect.andThen(projection.prepare(id)),
          ),
      }),
    );

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
