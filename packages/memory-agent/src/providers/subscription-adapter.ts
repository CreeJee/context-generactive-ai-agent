import {
  EventType,
  convertSchemaToJsonSchema,
  normalizeSystemPrompts,
  type AdapterYieldChunk,
  type DefaultMessageMetadataByModality,
  type ModelMessage,
  type TextOptions,
  type TokenUsage,
} from "@tanstack/ai";
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
  type StructuredOutputResult,
} from "@tanstack/ai/adapters";
import { createHash, randomUUID } from "node:crypto";
import { Option, Schema } from "effect";
import {
  ProviderFeatureRejectedError,
  ToolArguments,
  type NormalizedStreamEvent,
  type OAuthProvider,
} from "../oauth/protocol.ts";
import type { ModelSelection } from "./contracts.ts";

export interface StreamingOAuthClient {
  stream(body: string, signal?: AbortSignal): AsyncGenerator<NormalizedStreamEvent>;
}

const textOf = (content: ModelMessage["content"]) =>
  Array.isArray(content)
    ? content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("")
    : (content ?? "");

type WireBlock =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "output_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source:
        | { readonly type: "base64"; readonly media_type: string; readonly data: string }
        | { readonly type: "url"; readonly url: string };
    };

type WireContent = string | WireBlock[];

const openAiReasoningPrefix = "openai-reasoning:";
const maxEncryptedReasoningCharacters = 32 * 1024 * 1024;
const OpenAiReasoning = Schema.Struct({
  id: Schema.String,
  encryptedContent: Schema.String,
});
const decodeOpenAiReasoning = (signature: string) => {
  if (!signature.startsWith(openAiReasoningPrefix)) return null;
  try {
    return Option.getOrNull(
      Schema.decodeUnknownOption(Schema.fromJsonString(OpenAiReasoning))(
        Buffer.from(signature.slice(openAiReasoningPrefix.length), "base64url").toString("utf8"),
      ),
    );
  } catch {
    return null;
  }
};
const encodeOpenAiReasoning = (id: string, encryptedContent: string) =>
  `${openAiReasoningPrefix}${Buffer.from(JSON.stringify({ id, encryptedContent }), "utf8").toString(
    "base64url",
  )}`;

const openAiContent = (
  role: "user" | "assistant",
  content: ModelMessage["content"],
): WireBlock[] => {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (!Array.isArray(content))
    return content === undefined || content === null || content === ""
      ? []
      : [{ type: textType, text: content }];
  const blocks: WireBlock[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: textType, text: part.content });
    else if (part.type === "image") {
      const imageUrl =
        part.source.type === "data"
          ? `data:${part.source.mimeType};base64,${part.source.value}`
          : part.source.value;
      blocks.push({ type: "input_image", image_url: imageUrl });
    }
  }
  return blocks;
};

const anthropicContent = (content: ModelMessage["content"]): WireContent => {
  if (!Array.isArray(content)) return content ?? "";
  const blocks: WireBlock[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.content });
    else if (part.type === "image")
      blocks.push({
        type: "image",
        source:
          part.source.type === "data"
            ? { type: "base64", media_type: part.source.mimeType, data: part.source.value }
            : { type: "url", url: part.source.value },
      });
  }
  return blocks;
};

const decodeToolInput = Schema.decodeUnknownOption(Schema.fromJsonString(ToolArguments));
const toolInput = (serialized: string): typeof ToolArguments.Type =>
  Option.getOrElse(decodeToolInput(serialized), () => ({}));

const openAiInput = (messages: ReadonlyArray<ModelMessage>) => {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: textOf(message.content),
      });
      continue;
    }
    for (const thinking of message.thinking ?? []) {
      if (thinking.signature === undefined) continue;
      const reasoning = decodeOpenAiReasoning(thinking.signature);
      if (reasoning === null) continue;
      input.push({
        type: "reasoning",
        id: reasoning.id,
        summary: [],
        encrypted_content: reasoning.encryptedContent,
      });
    }
    const content = openAiContent(message.role, message.content);
    if (content.length > 0) input.push({ type: "message", role: message.role, content });
    for (const call of message.toolCalls ?? [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return input;
};

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: unknown[];
}

const appendAnthropicMessage = (
  output: AnthropicMessage[],
  role: AnthropicMessage["role"],
  blocks: unknown[],
) => {
  if (blocks.length === 0) return;
  const previous = output.at(-1);
  if (previous?.role === role) {
    output[output.length - 1] = { role, content: [...previous.content, ...blocks] };
    return;
  }
  output.push({ role, content: blocks });
};

const anthropicMessages = (messages: ReadonlyArray<ModelMessage>) => {
  const output: AnthropicMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "tool":
        appendAnthropicMessage(output, "user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: textOf(message.content),
            is_error: message.error !== undefined,
          },
        ]);
        break;
      case "user":
      case "assistant": {
        const converted = anthropicContent(message.content);
        const blocks: unknown[] = [];
        for (const thinking of message.thinking ?? []) {
          if (
            thinking.signature === undefined ||
            decodeOpenAiReasoning(thinking.signature) !== null
          )
            continue;
          blocks.push({
            type: "thinking",
            thinking: thinking.content,
            signature: thinking.signature,
          });
        }
        if (Array.isArray(converted)) blocks.push(...converted);
        else if (converted !== "") blocks.push({ type: "text", text: converted });
        for (const call of message.toolCalls ?? [])
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: toolInput(call.function.arguments),
          });
        appendAnthropicMessage(output, message.role, blocks);
        break;
      }
    }
  }
  return output;
};

const sha256 = (serialized: string) => createHash("sha256").update(serialized).digest("hex");
const systemText = (options: Pick<TextOptions<Record<string, never>>, "systemPrompts">) =>
  normalizeSystemPrompts(options.systemPrompts ?? [])
    .map((prompt) => prompt.content)
    .join("\n\n");
const canonicalTools = (options: Pick<TextOptions<Record<string, never>>, "tools">) =>
  (options.tools ?? [])
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: convertSchemaToJsonSchema(tool.inputSchema) ?? {
        type: "object",
        properties: {},
      },
    }))
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

export function requestFingerprints(
  options: Pick<TextOptions<Record<string, never>>, "messages" | "systemPrompts" | "tools">,
) {
  return {
    messageFingerprint: sha256(
      JSON.stringify({ system: systemText(options), messages: options.messages }),
    ),
    toolFingerprint: sha256(JSON.stringify(canonicalTools(options))),
  };
}

export function subscriptionRequest(
  provider: OAuthProvider,
  selection: ModelSelection,
  options: Pick<TextOptions<Record<string, never>>, "messages" | "systemPrompts" | "tools">,
  requestOptions: { readonly promptCache?: "provider-default" | "disabled" } = {},
) {
  const system = systemText(options);
  const tools = canonicalTools(options);
  if (provider === "anthropic") {
    const promptCache = requestOptions.promptCache !== "disabled";
    return JSON.stringify({
      model: selection.model,
      max_tokens: 32_000,
      stream: true,
      system:
        promptCache && system.length > 0
          ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }]
          : system,
      messages: anthropicMessages(options.messages),
      tools: tools.map((tool, index) =>
        promptCache && index === tools.length - 1
          ? { ...tool, cache_control: { type: "ephemeral", ttl: "1h" } }
          : tool,
      ),
      tool_choice: tools.length > 0 ? { type: "auto" } : undefined,
      output_config:
        selection.reasoningEffort === "none" ? undefined : { effort: selection.reasoningEffort },
    });
  }
  // The ChatGPT Responses subscription endpoint has no confirmed explicit cache-hint contract.
  // Keep its stable prefix and rely on the provider's automatic cache instead of sending API-only fields.
  return JSON.stringify({
    model: selection.model,
    instructions: system,
    input: openAiInput(options.messages),
    tools: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
    tool_choice: tools.length > 0 ? "auto" : undefined,
    parallel_tool_calls: true,
    reasoning: { effort: selection.reasoningEffort, summary: "auto" },
    include: ["reasoning.encrypted_content"],
    stream: true,
    store: false,
  });
}

const isPromptCacheRejection = (event: NormalizedStreamEvent) =>
  event.type === "error" &&
  /cache[_ -]?control|prompt[_ -]?cach/i.test(`${event.code} ${event.message}`) &&
  /invalid|unsupported|unknown|not (?:allowed|supported)|unrecognized/i.test(
    `${event.code} ${event.message}`,
  );

async function* providerEventsWithPromptCacheFallback(
  client: StreamingOAuthClient,
  provider: OAuthProvider,
  body: string,
  baselineBody: string,
  signal: AbortSignal | undefined,
  onFallback: () => void,
): AsyncGenerator<NormalizedStreamEvent> {
  let emitted = false;
  try {
    for await (const event of client.stream(body, signal)) {
      if (provider === "anthropic" && isPromptCacheRejection(event))
        throw new ProviderFeatureRejectedError("anthropic", "prompt-cache");
      emitted = true;
      yield event;
    }
    return;
  } catch (error) {
    if (
      provider !== "anthropic" ||
      emitted ||
      !(error instanceof ProviderFeatureRejectedError) ||
      error.feature !== "prompt-cache"
    )
      throw error;
  }
  onFallback();
  yield* client.stream(baselineBody, signal);
}

export class SubscriptionTextAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  ["text", "image"],
  DefaultMessageMetadataByModality
> {
  readonly name: OAuthProvider;
  readonly #client: StreamingOAuthClient;
  readonly #selection: ModelSelection;

  constructor(client: StreamingOAuthClient, selection: ModelSelection) {
    super({}, selection.model);
    this.name = selection.provider;
    this.#client = client;
    this.#selection = selection;
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    const signal = options.abortController?.signal ?? options.request?.signal ?? undefined;
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const messageId = randomUUID();
    const stamp = () => ({ model: this.model, timestamp: Date.now() });
    let textOpen = false;
    let toolCalls = 0;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let cachedPromptTokens: number | undefined;
    const streamingCalls = new Map<number, { readonly id: string; readonly name: string }>();
    const streamingReasoning = new Map<number, string>();

    yield { ...stamp(), type: EventType.RUN_STARTED, runId, threadId };
    const body = subscriptionRequest(this.name, this.#selection, options);
    const baselineBody = subscriptionRequest(this.name, this.#selection, options, {
      promptCache: "disabled",
    });
    const fingerprints = requestFingerprints(options);
    options.logger.request("subscription model request", {
      provider: this.name,
      model: this.model,
      messages: options.messages.length,
      tools: options.tools?.length ?? 0,
      ...fingerprints,
    });
    try {
      for await (const event of providerEventsWithPromptCacheFallback(
        this.#client,
        this.name,
        body,
        baselineBody,
        signal,
        () =>
          options.logger.provider("subscription prompt cache rejected; retrying baseline request", {
            provider: this.name,
          }),
      )) {
        if (signal?.aborted) return;
        options.logger.provider("subscription stream event", {
          provider: this.name,
          eventType: event.type,
        });
        if (event.type === "usage") {
          promptTokens = event.promptTokens ?? promptTokens;
          completionTokens = event.completionTokens ?? completionTokens;
          cachedPromptTokens = event.cachedPromptTokens ?? cachedPromptTokens;
          continue;
        }
        if (event.type === "error") throw new Error(`${this.name} ${event.code}: ${event.message}`);
        if (event.type === "reasoning") {
          if (event.encryptedContent.length > maxEncryptedReasoningCharacters)
            throw new Error("OpenAI returned an oversized encrypted reasoning item.");
          yield {
            ...stamp(),
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: "message",
            entityId: event.id,
            encryptedValue: encodeOpenAiReasoning(event.id, event.encryptedContent),
          };
          continue;
        }
        if (event.type === "text") {
          if (!textOpen) {
            textOpen = true;
            yield {
              ...stamp(),
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            };
          }
          yield {
            ...stamp(),
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: event.text,
          };
          continue;
        }
        if (event.type === "content-block-end" && textOpen) {
          textOpen = false;
          yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
          continue;
        }
        if (textOpen) {
          textOpen = false;
          yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
        }
        if (event.type === "tool-call") {
          const index = toolCalls++;
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_START,
            toolCallId: event.id,
            toolCallName: event.name,
            parentMessageId: messageId,
            index,
          };
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.id,
            delta: JSON.stringify(event.arguments),
          };
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_END,
            toolCallId: event.id,
            toolCallName: event.name,
          };
          continue;
        }
        if (event.type === "tool-call-start") {
          streamingCalls.set(event.index, { id: event.id, name: event.name });
          toolCalls += 1;
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_START,
            toolCallId: event.id,
            toolCallName: event.name,
            parentMessageId: messageId,
            index: event.index,
          };
          continue;
        }
        if (event.type === "reasoning-start") {
          const reasoningId = `reasoning-${event.index}`;
          streamingReasoning.set(event.index, reasoningId);
          yield {
            ...stamp(),
            type: EventType.REASONING_MESSAGE_START,
            messageId: reasoningId,
            role: "reasoning",
          };
          continue;
        }
        if (event.type === "reasoning-delta") {
          const reasoningId = streamingReasoning.get(event.index);
          if (!reasoningId) throw new Error(`${this.name} sent an invalid reasoning stream.`);
          yield {
            ...stamp(),
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: event.delta,
          };
          continue;
        }
        if (event.type === "reasoning-signature") {
          const reasoningId = streamingReasoning.get(event.index);
          if (!reasoningId) throw new Error(`${this.name} sent an invalid reasoning stream.`);
          yield {
            ...stamp(),
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: "message",
            entityId: reasoningId,
            encryptedValue: event.signature,
          };
          continue;
        }
        if (event.type === "tool-call-arguments") {
          const call = streamingCalls.get(event.index);
          if (!call) throw new Error(`${this.name} sent an invalid tool-call stream.`);
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: call.id,
            delta: event.delta,
          };
          continue;
        }
        const reasoningId = streamingReasoning.get(event.index);
        if (reasoningId) {
          streamingReasoning.delete(event.index);
          yield {
            ...stamp(),
            type: EventType.REASONING_MESSAGE_END,
            messageId: reasoningId,
          };
          continue;
        }
        const call = streamingCalls.get(event.index);
        if (!call) throw new Error(`${this.name} sent an invalid content block end.`);
        streamingCalls.delete(event.index);
        yield {
          ...stamp(),
          type: EventType.TOOL_CALL_END,
          toolCallId: call.id,
          toolCallName: call.name,
        };
      }
    } catch (error) {
      if (signal?.aborted) return;
      options.logger.errors("subscription model request failed", {
        provider: this.name,
        message: error instanceof Error ? error.message : "unknown provider failure",
      });
      throw error;
    }
    if (textOpen) yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
    const finished: AdapterYieldChunk = {
      ...stamp(),
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: toolCalls > 0 ? "tool_calls" : "stop",
    };
    if (promptTokens !== undefined || completionTokens !== undefined) {
      const usage: TokenUsage = {
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      };
      if (cachedPromptTokens !== undefined)
        usage.promptTokensDetails = { cachedTokens: cachedPromptTokens };
      finished.usage = usage;
    }
    yield finished;
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(
      new Error("Subscription adapters do not support separate structured output."),
    );
  }
}
