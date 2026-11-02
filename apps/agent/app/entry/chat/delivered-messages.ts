import { Function as EffectFunction } from "effect";
import type { ChatMessage } from "memory-agent/chat-api";
import type { QueuedMessage } from "memory-agent/definitions";

/** A delivered queue item is temporary UI only until its user turn appears in the transcript. */
export const missingDeliveredMessages: {
  (
    messages: readonly ChatMessage[],
  ): (items: readonly QueuedMessage[]) => ReturnType<typeof missingDeliveredMessagesBody>;
} & typeof missingDeliveredMessagesBody = EffectFunction.dual(2, missingDeliveredMessagesBody);
function missingDeliveredMessagesBody(
  items: readonly QueuedMessage[],
  messages: readonly ChatMessage[],
): QueuedMessage[] {
  return items.filter((item) => !messages.some((message) => message.id === item.id));
}
