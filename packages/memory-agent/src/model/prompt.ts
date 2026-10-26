import { Function as EffectFunction, Option, Predicate, Schema } from "effect";
import { Prompt } from "effect/ai";
import {
  StoredAssistantMessage,
  StoredUserMessage,
  type StoredMessage,
} from "../chat-store/schema.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * Stored messages as an Effect `Prompt`, and back. What `Prompt` has no field for goes in
 * `options[optionsKey]`, so providers read reasoning signatures and tool call arguments as the
 * model sent them, and the conversion round-trips without loss.
 */

export const optionsKey = "memory-agent";

type UserMessage = Extract<StoredMessage, { readonly role: "user" }>;
type AssistantMessage = Extract<StoredMessage, { readonly role: "assistant" }>;
type ToolMessage = Extract<StoredMessage, { readonly role: "tool" }>;
/** User and tool message content as stored: text, or text and image parts. */
export type StoredContent = UserMessage["content"];
type ContentPart = Exclude<StoredContent, string>[number];

const { id, createdAt } = StoredUserMessage.fields;
const { model, source, finishReason, stopReason } = StoredAssistantMessage.fields;

/** What a message keeps beside its parts. */
const MessageOptions = Schema.Struct({
  id,
  createdAt,
  model,
  source,
  finishReason,
  stopReason,
  /** The user content was a string rather than parts. */
  text: Schema.optionalKey(Schema.Literal(true)),
  /** The assistant content was `null` or `""` rather than absent; text becomes a part. */
  content: Schema.optionalKey(Schema.NullOr(Schema.Literal(""))),
});

/** What a part keeps beside its fields. */
export const PartOptions = Schema.Struct({
  /** Reasoning: the provider's signature, or OpenAI encrypted reasoning packed by the provider. */
  signature: Schema.optionalKey(Schema.String),
  /** Reasoning: the provider encrypted the block, so `text` is empty. */
  redacted: Schema.optionalKey(Schema.Boolean),
  /** Tool call: the arguments as the model sent them, which may not parse. */
  arguments: Schema.optionalKey(Schema.String),
  /** Tool result: the stored error text. */
  error: Schema.optionalKey(Schema.String),
  /** Image: `data` is a URL rather than base64. */
  url: Schema.optionalKey(Schema.Literal(true)),
  /** Image: a URL stored without a MIME type, sent as `image/*`. */
  untyped: Schema.optionalKey(Schema.Literal(true)),
});
export type PartOptions = typeof PartOptions.Type;

const decodeMessageOptions = Schema.decodeUnknownOption(MessageOptions);
const decodePartOptions = Schema.decodeUnknownOption(PartOptions);
const decodeToolContent = Schema.decodeUnknownOption(StoredUserMessage.fields.content);

const messageOptions = (message: Prompt.Message): typeof MessageOptions.Type =>
  Option.getOrElse(decodeMessageOptions(message.options[optionsKey]), () => ({}));

/** The stored content `toPrompt` put in a tool result; empty for a result made elsewhere. */
export const toolResultContent = (part: Prompt.ToolResultPart): StoredContent =>
  Option.getOrElse(decodeToolContent(part.result), () => "");

/** This app's options on a prompt part; empty for a part made elsewhere. */
export const partOptions = (part: Prompt.Part): PartOptions =>
  Option.getOrElse(decodePartOptions(part.options[optionsKey]), () => ({}));

const decodeArguments = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const encodeArguments = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown));

const filePart = (part: Extract<ContentPart, { readonly type: "image" }>) =>
  Prompt.filePart({
    mediaType: part.source.mimeType ?? "image/*",
    data: part.source.value,
    options: {
      [optionsKey]: {
        ...optionalProperty("url", part.source.type === "url" ? true : undefined),
        ...optionalProperty("untyped", part.source.mimeType === undefined ? true : undefined),
      },
    },
  });

const contentParts = (content: ReadonlyArray<ContentPart>) =>
  content.map((part) =>
    part.type === "text" ? Prompt.textPart({ text: part.content }) : filePart(part),
  );

const userMessage = ({ role: _role, content, ...kept }: UserMessage) =>
  Prompt.userMessage({
    content: Predicate.isString(content)
      ? content === ""
        ? []
        : [Prompt.textPart({ text: content })]
      : contentParts(content),
    options: {
      [optionsKey]: {
        ...kept,
        ...optionalProperty("text", Predicate.isString(content) ? true : undefined),
      },
    },
  });

const assistantMessage = ({
  role: _role,
  content,
  thinking,
  toolCalls,
  ...kept
}: AssistantMessage) =>
  Prompt.assistantMessage({
    content: [
      ...(thinking ?? []).map(({ content: text, ...signed }) =>
        Prompt.reasoningPart({ text, options: { [optionsKey]: signed } }),
      ),
      ...(content === undefined || content === null || content === ""
        ? []
        : [Prompt.textPart({ text: content })]),
      ...(toolCalls ?? []).map((call) =>
        Prompt.toolCallPart({
          id: call.id,
          name: call.function.name,
          params: Option.getOrElse(decodeArguments(call.function.arguments), () => ({})),
          providerExecuted: false,
          options: { [optionsKey]: { arguments: call.function.arguments } },
        }),
      ),
    ],
    options: {
      [optionsKey]: {
        ...kept,
        ...optionalProperty("content", content === null || content === "" ? content : undefined),
      },
    },
  });

const toolMessage = (
  { role: _role, toolCallId, content, error, ...kept }: ToolMessage,
  name: string,
) =>
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: toolCallId,
        name,
        isFailure: error !== undefined,
        result: content,
        providerExecuted: false,
        options: { [optionsKey]: optionalProperty("error", error) },
      }),
    ],
    options: { [optionsKey]: kept },
  });

/**
 * The prompt for `system` and `history`, which is already the provider history
 * (`providerHistory`). A tool result takes its name from the call it answers.
 */
export const toPrompt: {
  (system: ReadonlyArray<string>): (history: ReadonlyArray<StoredMessage>) => Prompt.Prompt;
  (history: ReadonlyArray<StoredMessage>, system: ReadonlyArray<string>): Prompt.Prompt;
} = EffectFunction.dual(2, toPromptBody);
function toPromptBody(
  history: ReadonlyArray<StoredMessage>,
  system: ReadonlyArray<string>,
): Prompt.Prompt {
  const names = new Map<string, string>();
  const messages: Array<Prompt.Message> = system.map((content) =>
    Prompt.systemMessage({ content }),
  );
  for (const message of history)
    switch (message.role) {
      case "user":
        messages.push(userMessage(message));
        break;
      case "assistant":
        for (const call of message.toolCalls ?? []) names.set(call.id, call.function.name);
        messages.push(assistantMessage(message));
        break;
      case "tool":
        messages.push(toolMessage(message, names.get(message.toolCallId) ?? ""));
        break;
    }
  return Prompt.fromMessages(messages);
}

const storedContent = (parts: ReadonlyArray<Prompt.UserMessagePart>): Array<ContentPart> =>
  parts.map((part) => {
    if (part.type === "text") return { type: "text", content: part.text };
    const options = partOptions(part);
    // `toPrompt` keeps image data as the stored string.
    const value = String(part.data);
    if (options.url !== true)
      return { type: "image", source: { type: "data", value, mimeType: part.mediaType } };
    return {
      type: "image",
      source: {
        type: "url",
        value,
        ...optionalProperty("mimeType", options.untyped === true ? undefined : part.mediaType),
      },
    };
  });

const textOf = (parts: ReadonlyArray<Prompt.AssistantMessagePart>) =>
  parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** The system prompts and stored messages a prompt holds; the inverse of `toPrompt`. */
export const fromPrompt = (prompt: Prompt.Prompt) => {
  const system: Array<string> = [];
  const history: Array<StoredMessage> = [];
  for (const message of prompt.content)
    switch (message.role) {
      case "system":
        system.push(message.content);
        break;
      case "user": {
        const { text, content: _content, ...kept } = messageOptions(message);
        const content = storedContent(message.content);
        history.push({
          role: "user",
          ...kept,
          content:
            text === true
              ? content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")
              : content,
        });
        break;
      }
      case "assistant": {
        const { text: _text, content: empty, ...kept } = messageOptions(message);
        const thinking = message.content.flatMap((part) => {
          if (part.type !== "reasoning") return [];
          const { signature, redacted } = partOptions(part);
          return [
            {
              content: part.text,
              ...optionalProperty("signature", signature),
              ...optionalProperty("redacted", redacted),
            },
          ];
        });
        const toolCalls = message.content.flatMap((part) =>
          part.type === "tool-call"
            ? [
                {
                  id: part.id,
                  type: "function" as const,
                  function: {
                    name: part.name,
                    arguments:
                      partOptions(part).arguments ??
                      Option.getOrElse(encodeArguments(part.params), () => "{}"),
                  },
                },
              ]
            : [],
        );
        const text = textOf(message.content);
        history.push({
          role: "assistant",
          ...kept,
          ...(text !== "" ? { content: text } : optionalProperty("content", empty)),
          ...optionalProperty("thinking", thinking.length > 0 ? thinking : undefined),
          ...optionalProperty("toolCalls", toolCalls.length > 0 ? toolCalls : undefined),
        });
        break;
      }
      case "tool": {
        const { id: messageId, createdAt: messageCreatedAt } = messageOptions(message);
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          history.push({
            role: "tool",
            ...optionalProperty("id", messageId),
            ...optionalProperty("createdAt", messageCreatedAt),
            toolCallId: part.id,
            content: toolResultContent(part),
            ...optionalProperty("error", partOptions(part).error),
          });
        }
        break;
      }
    }
  return { system, history };
};
