import type { ModelMessage } from "@tanstack/ai";

/** Plain text of a model message; images and other media are left out. */
export function messageText(message: ModelMessage): string {
  if (Array.isArray(message.content))
    return message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
  return message.content ?? "";
}
