import {
  Array as Arr,
  DateTime,
  Effect,
  Function as EffectFunction,
  HashSet,
  Option,
} from "effect";
import { type StoredMessage, StoredUserMessage } from "../chat-store/schema.ts";

/**
 * What a chat request adds to the thread on the Effect AI loop (docs/effect-ai-migration.md step
 * 4). The thread holds the conversation, so the page sends only its new user turn: the answers and
 * tool results were written by runs and are already stored.
 */

/** The user messages of a request as the thread keeps them, each with the time the server received it. */
export const pageTurns = (messages: ReadonlyArray<typeof StoredUserMessage.Type>) =>
  Effect.map(DateTime.now, (now) =>
    messages.map((message) =>
      StoredUserMessage.make({ ...message, createdAt: DateTime.formatIso(now) }),
    ),
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
