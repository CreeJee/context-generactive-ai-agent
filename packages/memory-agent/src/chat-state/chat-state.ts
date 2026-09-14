import { convertMessagesToModelMessages } from "@tanstack/ai";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { Context, Effect, Layer } from "effect";
import { sessionMessages } from "../agent/history.ts";
import { Attachments } from "../attachments/attachments.ts";
import { Database } from "../db/database.ts";
import { Nodes } from "../memory/nodes.ts";
import { sqliteChatPersistence } from "./persistence.ts";

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const nodes = yield* Nodes;
  const attachments = yield* Attachments;

  // A session recorded before chat state existed opens with the transcript rebuilt from its nodes.
  const persistence = sqliteChatPersistence(sqlite, (threadId) =>
    convertMessagesToModelMessages(sessionMessages(nodes.session(threadId), attachments.forNode)),
  );

  return {
    persistence,

    /** Saves each run's transcript, run record and pending approvals as the run goes. */
    middleware: () => withPersistence(persistence),

    /**
     * The `GET` a reloaded page hydrates from: transcript, a still-running run to rejoin, and
     * pending approvals to show again. Only the session's own thread may be read.
     */
    hydrate: (request: Request, sessionId: string) =>
      reconstructChat(persistence, request, {
        authorize: async (threadId) => threadId === sessionId,
      }),
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
