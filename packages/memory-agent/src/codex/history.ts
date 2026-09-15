import type { ContentPart, ModelMessage } from "@tanstack/ai";
import type { Json } from "./app-server.ts";

/** Plain text of a message; images and other media are left out. */
export function messageText(message: ModelMessage): string {
  if (Array.isArray(message.content))
    return message.content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
  return message.content ?? "";
}

/** A stored image an image part points to, in the two forms codex accepts. */
export interface ResolvedImage {
  /** For `turn/start` input (`localImage`). */
  readonly path: string;
  /** For injected history (`input_image`). */
  readonly dataUrl: string;
}

/** Resolved images keyed by the image part's source value. */
export type ImageLookup = ReadonlyMap<string, ResolvedImage>;

const partsOf = (message: ModelMessage): readonly ContentPart[] =>
  Array.isArray(message.content)
    ? message.content
    : [{ type: "text", content: message.content ?? "" }];

/**
 * User turns, counting the one being answered, whose tool output and images go to codex whole.
 * Older ones are shortened when injected: a run starts a fresh codex thread with the whole
 * conversation, and tool output (file reads, shell, web pages) is most of it. The nodes keep
 * everything, so the model can read it again with a tool.
 */
export const wholeTurns = 2;
/** Characters kept from the start of an older tool output. */
export const keptToolCharacters = 1_000;

/** Index of the first message of the {@link wholeTurns} most recent user turns. */
function recentFrom(messages: readonly ModelMessage[]) {
  const userTurns = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  return userTurns.at(-wholeTurns) ?? 0;
}

/** Older tool output, cut to its start with a note saying how much is left out and how to see it. */
function shortenedOutput(text: string) {
  if (text.length <= keptToolCharacters) return text;
  const omitted = text.length - keptToolCharacters;
  return `${text.slice(0, keptToolCharacters)}\n… [older tool output shortened: ${omitted} more characters. Call the tool again if you need them.]`;
}

/**
 * Image source values the conversion sends as images (those of recent turns), so the caller
 * resolves only those before converting.
 */
export function imageSources(messages: readonly ModelMessage[]): string[] {
  return messages
    .slice(recentFrom(messages))
    .flatMap((message) =>
      partsOf(message).flatMap((part) => (part.type === "image" ? [part.source.value] : [])),
    );
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
 * Images are forwarded only when `images` resolved them; unknown sources are dropped. Tool output
 * and images older than {@link wholeTurns} user turns are shortened (see there).
 */
export function toCodexTurnInput(
  messages: readonly ModelMessage[],
  images: ImageLookup,
): CodexTurnInput {
  const last = messages.at(-1);
  const trailingUser = last?.role === "user" ? last : null;
  const earlier = trailingUser ? messages.slice(0, -1) : messages;
  const recent = recentFrom(messages);

  const history = earlier.flatMap((message, index): Json[] => {
    const text = messageText(message);
    const old = index < recent;
    switch (message.role) {
      case "user":
        return [
          {
            type: "message",
            role: "user",
            content: partsOf(message).flatMap((part): Json[] => {
              switch (part.type) {
                case "text":
                  return [{ type: "input_text", text: part.content }];
                case "image": {
                  if (old) return [{ type: "input_text", text: "[image from an earlier message]" }];
                  const image = images.get(part.source.value);
                  return image ? [{ type: "input_image", image_url: image.dataUrl }] : [];
                }
                default:
                  return [];
              }
            }),
          },
        ];
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
          ? [
              {
                type: "function_call_output",
                call_id: message.toolCallId,
                output: old ? shortenedOutput(text) : text,
              },
            ]
          : [];
    }
  });

  const input = trailingUser
    ? partsOf(trailingUser).flatMap((part): Json[] => {
        switch (part.type) {
          case "text":
            return part.content.length > 0
              ? [{ type: "text", text: part.content, text_elements: [] }]
              : [];
          case "image": {
            const image = images.get(part.source.value);
            return image ? [{ type: "localImage", path: image.path }] : [];
          }
          default:
            return [];
        }
      })
    : [];

  return { history, input };
}
