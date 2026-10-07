import { Function as EffectFunction } from "effect";
import type { UIMessage } from "@tanstack/ai-react";
import { attachmentIdOf, type QueuedMessage } from "memory-agent/definitions";

/** A delivered queue item is temporary UI only until its user turn appears in the transcript. */
export const missingDeliveredMessages: {
  (
    messages: readonly UIMessage[],
  ): (items: readonly QueuedMessage[]) => ReturnType<typeof missingDeliveredMessagesBody>;
} & typeof missingDeliveredMessagesBody = EffectFunction.dual(2, missingDeliveredMessagesBody);
function missingDeliveredMessagesBody(
  items: readonly QueuedMessage[],
  messages: readonly UIMessage[],
): QueuedMessage[] {
  // Older turns were saved without the queue id. Reconcile those by their exact contents, but only
  // after an assistant turn: the initial user request must not consume an identical follow-up.
  const legacyMatches = messages.flatMap((message, index) => {
    if (
      message.role !== "user" ||
      items.some((item) => item.id === message.id) ||
      !messages.slice(0, index).some((prior) => prior.role === "assistant")
    )
      return [];
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.content] : []))
      .join("");
    const attachmentIds = message.parts.flatMap((part) =>
      part.type === "image" && part.source.type === "url"
        ? (attachmentIdOf(part.source.value) ?? [])
        : [],
    );
    return [{ text, attachmentIds }];
  });
  return items.filter((item) => {
    if (messages.some((message) => message.id === item.id)) return false;
    const match = legacyMatches.findIndex(
      (message) =>
        message.text === item.text &&
        message.attachmentIds.length === item.attachmentIds.length &&
        message.attachmentIds.every((id, index) => id === item.attachmentIds[index]),
    );
    if (match === -1) return true;
    legacyMatches.splice(match, 1);
    return false;
  });
}
