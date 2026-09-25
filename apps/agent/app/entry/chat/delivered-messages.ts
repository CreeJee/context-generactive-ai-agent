import type { UIMessage } from "@tanstack/ai-react";
import { attachmentIdOf, type QueuedMessage } from "memory-agent/definitions";

/** A delivered queue item is temporary UI only until its user turn appears in the transcript. */
export function missingDeliveredMessages(
  items: readonly QueuedMessage[],
  messages: readonly UIMessage[],
): QueuedMessage[] {
  const transcriptIds = new Set(messages.map((message) => message.id));
  const queuedIds = new Set(items.map((item) => item.id));
  // Older turns were saved without the queue id. Reconcile those by their exact contents, but only
  // after an assistant turn: the initial user request must not consume an identical follow-up.
  const legacyMatches = messages.flatMap((message, index) => {
    if (
      message.role !== "user" ||
      queuedIds.has(message.id) ||
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
    if (transcriptIds.has(item.id)) return false;
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
