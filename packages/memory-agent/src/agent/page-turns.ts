import { convertMessagesToModelMessages, type ModelMessage, type UIMessage } from "@tanstack/ai";
import { Array as Arr, Effect, Function as EffectFunction, HashSet, Option, Schema } from "effect";
import { type StoredMessage, StoredUserMessage } from "../chat-store/schema.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * What a chat request adds to the thread on the Effect AI loop (docs/effect-ai-migration.md step
 * 4). The page holds the conversation it shows and sends all of it, but it writes only user
 * messages: the answers and tool results it holds were written by runs and are already stored.
 */

/**
 * The user messages of a request as the thread keeps them, with the time the page gave each. A
 * message the thread cannot keep, such as one with an audio part, fails.
 */
export const pageTurns = (messages: ReadonlyArray<UIMessage | ModelMessage>) =>
  Effect.forEach(
    convertMessagesToModelMessages([...messages]).filter((message) => message.role === "user"),
    (message) =>
      Schema.decodeUnknownEffect(StoredUserMessage)({
        role: "user",
        ...optionalProperty("id", message.id),
        ...optionalProperty("createdAt", message.createdAt?.toISOString()),
        content: message.content,
      }),
  );

/** The stored thread with the turns it does not hold yet. Stored messages stay as they were saved. */
export const withPageTurns: {
  (
    turns: ReadonlyArray<typeof StoredUserMessage.Type>,
  ): (stored: ReadonlyArray<StoredMessage>) => Array<StoredMessage>;
  (
    stored: ReadonlyArray<StoredMessage>,
    turns: ReadonlyArray<typeof StoredUserMessage.Type>,
  ): Array<StoredMessage>;
} = EffectFunction.dual(
  2,
  (stored: ReadonlyArray<StoredMessage>, turns: ReadonlyArray<typeof StoredUserMessage.Type>) => {
    const held = HashSet.fromIterable(
      Arr.getSomes(stored.map((message) => Option.fromNullishOr(message.id))),
    );
    return [
      ...stored,
      ...turns.filter(
        (turn) => !Option.exists(Option.fromNullishOr(turn.id), (id) => HashSet.has(held, id)),
      ),
    ];
  },
);
