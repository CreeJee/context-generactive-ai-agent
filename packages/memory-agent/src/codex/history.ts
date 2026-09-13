import type { ModelMessage } from "@tanstack/ai";
import type { Json } from "./app-server.ts";

/** Plain text of a message. Non-text parts (images, audio) are not forwarded to codex yet. */
export function messageText(message: ModelMessage): string {
  if (Array.isArray(message.content))
    return message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
  return message.content ?? "";
}

export interface CodexTurnInput {
  /** Responses API items appended to the fresh thread with `thread/inject_items`. */
  readonly history: Json[];
  /** Codex user input for `turn/start`. Empty when the run continues after tool results. */
  readonly input: Json[];
}

/**
 * Splits TanStack messages into injected history and the new turn input.
 * A trailing user message becomes the turn input; anything else (e.g. tool results) is history
 * and the turn starts with no new input, which codex answers from the injected items.
 */
export function toCodexTurnInput(messages: readonly ModelMessage[]): CodexTurnInput {
  const last = messages.at(-1);
  const trailingUser = last?.role === "user" ? last : null;
  const earlier = trailingUser ? messages.slice(0, -1) : messages;

  const history = earlier.flatMap((message): Json[] => {
    const text = messageText(message);
    switch (message.role) {
      case "user":
        return [{ type: "message", role: "user", content: [{ type: "input_text", text }] }];
      case "assistant":
        return [
          ...(text.length > 0
            ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]
            : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        ];
      case "tool":
        return message.toolCallId
          ? [{ type: "function_call_output", call_id: message.toolCallId, output: text }]
          : [];
    }
  });

  return {
    history,
    input: trailingUser
      ? [{ type: "text", text: messageText(trailingUser), text_elements: [] }]
      : [],
  };
}
