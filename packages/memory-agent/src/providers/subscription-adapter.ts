import { isTruthy } from "../truthy.ts";
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
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import { Cause, Effect, Stream, MutableHashMap, DateTime, Option, Schema } from "effect";
import {
  ProviderFeatureRejectedError,
  ReasoningSummaryProtocolFailed,
  ToolArguments,
  type NormalizedStreamEvent,
  type OAuthProvider,
} from "../oauth/protocol.ts";
import type { ModelSelection, SubscriptionModelSelection } from "./contracts.ts";

export interface StreamingOAuthClient {
  readonly releaseRun?: () => void;
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
export const publicReasoningLimits = {
  characters: 2 * 1024 * 1024,
  parts: 256,
  idCharacters: 512,
} as const;

export class SubscriptionStreamFailed extends Schema.TaggedError<SubscriptionStreamFailed>()(
  "SubscriptionStreamFailed",
  {
    provider: Schema.Literals(["openai", "anthropic"]),
    reason: Schema.Union([
      Schema.TaggedStruct("ProviderRejected", {}),
      Schema.TaggedStruct("TransportUnavailable", {}),
      Schema.TaggedStruct("InvalidReasoning", {}),
      Schema.TaggedStruct("InvalidToolCall", {}),
      Schema.TaggedStruct("InvalidBlockEnd", {}),
      Schema.TaggedStruct("IncompleteBlocks", {}),
      Schema.TaggedStruct("EncryptedReasoningLimit", {}),
    ]),
  },
) {
  override get message() {
    return "Subscription provider stream failed.";
  }
}
const OpenAiReasoning = Schema.Struct({
  id: Schema.String,
  encryptedContent: Schema.String,
});
const decodeOpenAiReasoning = (signature: string) => {
  if (!signature.startsWith(openAiReasoningPrefix)) return null;
  try {
    return Option.getOrNull(
      Schema.decodeOption(Schema.fromJsonString(OpenAiReasoning))(
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

const decodeToolInput = Schema.decodeOption(Schema.fromJsonString(ToolArguments));
const toolInput = (serialized: string): ToolArguments =>
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

const sha256 = (serialized: string) =>
  Buffer.from(
    Effect.runSync(oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(serialized))),
  ).toString("hex");
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

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function subscriptionRequest(options: {
  readonly provider: OAuthProvider;
  readonly selection: ModelSelection;
  readonly options: Pick<
    TextOptions<Record<string, never>>,
    "messages" | "systemPrompts" | "tools"
  >;
  readonly requestOptions?: { readonly promptCache?: "provider-default" | "disabled" } | undefined;
}) {
  return subscriptionRequestBody(
    options.provider,
    options.selection,
    options.options,
    options.requestOptions,
  );
}
function subscriptionRequestBody(
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

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function providerEventsWithPromptCacheFallback(
  client: StreamingOAuthClient,
  provider: OAuthProvider,
  body: string,
  baselineBody: string,
  signal: AbortSignal | undefined,
  onFallback: () => void,
) {
  return Stream.suspend(() => {
    let emitted = false;
    const source = (request: string) =>
      Stream.fromAsyncIterable(
        client.stream(request, signal),
        (cause) => new Cause.UnknownError(cause),
      );
    return source(body).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          if (provider === "anthropic" && isPromptCacheRejection(event))
            return yield* new ProviderFeatureRejectedError("anthropic", "prompt-cache");
          emitted = true;
          return event;
        }),
      ),
      Stream.catch((failure) => {
        const error = failure instanceof Cause.UnknownError ? failure.cause : failure;
        if (
          provider !== "anthropic" ||
          emitted ||
          !(error instanceof ProviderFeatureRejectedError) ||
          error.feature !== "prompt-cache"
        )
          return Stream.fail(failure);
        return Stream.suspend(() => {
          onFallback();
          return source(baselineBody);
        });
      }),
    );
  });
}

export class SubscriptionTextAdapter extends BaseTextAdapter<
  string,
  Record<string, never>,
  ["text", "image"],
  DefaultMessageMetadataByModality
> {
  readonly name: OAuthProvider;
  readonly #client: StreamingOAuthClient;
  readonly #selection: SubscriptionModelSelection;

  constructor(client: StreamingOAuthClient, selection: SubscriptionModelSelection) {
    super({}, selection.model);
    this.name = selection.provider;
    this.#client = client;
    this.#selection = selection;
  }

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<AdapterYieldChunk> {
    return Stream.toAsyncIterable(
      Stream.suspend(() => {
        const providerName = this.name;
        const signal = options.abortController?.signal ?? options.request?.signal ?? undefined;
        const runId = options.runId ?? Effect.runSync(oauthProtocolCrypto.randomUUIDv4());
        const threadId = options.threadId ?? Effect.runSync(oauthProtocolCrypto.randomUUIDv4());
        const messageId = Effect.runSync(oauthProtocolCrypto.randomUUIDv4());
        const stamp = () => ({
          model: this.model,
          timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
        });
        let textOpen = false;
        let toolCalls = 0;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let cachedPromptTokens: number | undefined;
        const streamingCalls = MutableHashMap.empty<
          number,
          { readonly id: string; readonly name: string }
        >();
        const streamingReasoning = MutableHashMap.empty<number, string>();
        let summaryCharacters = 0;
        let summaryCount = 0;
        let openSummaries = 0;
        const summaries = MutableHashMap.empty<
          string,
          { readonly type: "open"; readonly text: string } | { readonly type: "closed" }
        >();

        const translate = function* (
          event: NormalizedStreamEvent,
        ): Generator<AdapterYieldChunk, void, unknown> {
          if (signal?.aborted === true) return;
          options.logger.provider("subscription stream event", {
            provider: providerName,
            eventType: event.type,
          });
          if (event.type === "usage") {
            promptTokens = event.promptTokens ?? promptTokens;
            completionTokens = event.completionTokens ?? completionTokens;
            cachedPromptTokens = event.cachedPromptTokens ?? cachedPromptTokens;
            return;
          }
          if (event.type === "error")
            throw SubscriptionStreamFailed.make({
              provider: providerName,
              reason: { _tag: "ProviderRejected" },
            });
          // Public OpenAI summary parts are SDK reasoning messages, not Anthropic block ends.
          switch (event.type) {
            case "reasoning-summary-start": {
              const summaryId = `reasoning-summary-${event.id}-${event.summaryIndex}`;
              if (MutableHashMap.has(summaries, summaryId))
                throw ReasoningSummaryProtocolFailed.make({
                  reason: { _tag: "ConflictingSummary" },
                });
              if (
                summaryCount >= publicReasoningLimits.parts ||
                event.id.length > publicReasoningLimits.idCharacters ||
                summaryCharacters + event.text.length > publicReasoningLimits.characters
              )
                throw ReasoningSummaryProtocolFailed.make({ reason: { _tag: "ResourceLimit" } });
              summaryCount++;
              openSummaries++;
              summaryCharacters += event.text.length;
              MutableHashMap.set(summaries, summaryId, { type: "open", text: event.text });
              yield {
                ...stamp(),
                type: EventType.REASONING_MESSAGE_START,
                messageId: summaryId,
                role: "reasoning",
              };
              if (event.text.length > 0)
                yield {
                  ...stamp(),
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: summaryId,
                  delta: event.text,
                };
              return;
            }
            case "reasoning-summary-delta":
            case "reasoning-summary-end": {
              const summaryId = `reasoning-summary-${event.id}-${event.summaryIndex}`;
              const summary = Option.getOrUndefined(MutableHashMap.get(summaries, summaryId));
              if (summary === undefined)
                throw ReasoningSummaryProtocolFailed.make({
                  reason: { _tag: "ConflictingSummary" },
                });
              switch (summary.type) {
                case "closed":
                  throw ReasoningSummaryProtocolFailed.make({ reason: { _tag: "AlreadyEnded" } });
                case "open": {
                  switch (event.type) {
                    case "reasoning-summary-delta":
                      if (summaryCharacters + event.delta.length > publicReasoningLimits.characters)
                        throw ReasoningSummaryProtocolFailed.make({
                          reason: { _tag: "ResourceLimit" },
                        });
                      summaryCharacters += event.delta.length;
                      MutableHashMap.set(summaries, summaryId, {
                        type: "open",
                        text: summary.text + event.delta,
                      });
                      yield {
                        ...stamp(),
                        type: EventType.REASONING_MESSAGE_CONTENT,
                        messageId: summaryId,
                        delta: event.delta,
                      };
                      break;
                    case "reasoning-summary-end": {
                      if (!event.text.startsWith(summary.text))
                        throw ReasoningSummaryProtocolFailed.make({
                          reason: { _tag: "ConflictingSummary" },
                        });
                      const remaining = event.text.slice(summary.text.length);
                      if (summaryCharacters + remaining.length > publicReasoningLimits.characters)
                        throw ReasoningSummaryProtocolFailed.make({
                          reason: { _tag: "ResourceLimit" },
                        });
                      summaryCharacters += remaining.length;
                      openSummaries--;
                      if (remaining.length > 0)
                        yield {
                          ...stamp(),
                          type: EventType.REASONING_MESSAGE_CONTENT,
                          messageId: summaryId,
                          delta: remaining,
                        };
                      MutableHashMap.set(summaries, summaryId, { type: "closed" });
                      yield {
                        ...stamp(),
                        type: EventType.REASONING_MESSAGE_END,
                        messageId: summaryId,
                      };
                      break;
                    }
                  }
                  break;
                }
              }
              return;
            }
            default:
              break;
          }
          if (event.type === "reasoning") {
            if (event.encryptedContent.length > maxEncryptedReasoningCharacters)
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "EncryptedReasoningLimit" },
              });
            yield {
              ...stamp(),
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: "message",
              entityId: event.id,
              encryptedValue: encodeOpenAiReasoning(event.id, event.encryptedContent),
            };
            return;
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
            return;
          }
          if (event.type === "content-block-end" && textOpen) {
            textOpen = false;
            yield { ...stamp(), type: EventType.TEXT_MESSAGE_END, messageId };
            return;
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
            return;
          }
          if (event.type === "tool-call-start") {
            if (
              MutableHashMap.has(streamingCalls, event.index) ||
              MutableHashMap.has(streamingReasoning, event.index)
            )
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "InvalidToolCall" },
              });
            MutableHashMap.set(streamingCalls, event.index, { id: event.id, name: event.name });
            toolCalls += 1;
            yield {
              ...stamp(),
              type: EventType.TOOL_CALL_START,
              toolCallId: event.id,
              toolCallName: event.name,
              parentMessageId: messageId,
              index: event.index,
            };
            return;
          }
          if (event.type === "reasoning-start") {
            if (
              MutableHashMap.has(streamingReasoning, event.index) ||
              MutableHashMap.has(streamingCalls, event.index)
            )
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "InvalidReasoning" },
              });
            const reasoningId = `reasoning-${event.index}`;
            MutableHashMap.set(streamingReasoning, event.index, reasoningId);
            yield {
              ...stamp(),
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
            };
            return;
          }
          if (event.type === "reasoning-delta") {
            const reasoningId = Option.getOrUndefined(
              MutableHashMap.get(streamingReasoning, event.index),
            );
            if (!isTruthy(reasoningId))
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "InvalidReasoning" },
              });
            yield {
              ...stamp(),
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: reasoningId,
              delta: event.delta,
            };
            return;
          }
          if (event.type === "reasoning-signature") {
            const reasoningId = Option.getOrUndefined(
              MutableHashMap.get(streamingReasoning, event.index),
            );
            if (!isTruthy(reasoningId))
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "InvalidReasoning" },
              });
            yield {
              ...stamp(),
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: "message",
              entityId: reasoningId,
              encryptedValue: event.signature,
            };
            return;
          }
          if (event.type === "tool-call-arguments") {
            const call = Option.getOrUndefined(MutableHashMap.get(streamingCalls, event.index));
            if (!isTruthy(call))
              throw SubscriptionStreamFailed.make({
                provider: providerName,
                reason: { _tag: "InvalidToolCall" },
              });
            yield {
              ...stamp(),
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: event.delta,
            };
            return;
          }
          const reasoningId = Option.getOrUndefined(
            MutableHashMap.get(streamingReasoning, event.index),
          );
          if (isTruthy(reasoningId)) {
            MutableHashMap.remove(streamingReasoning, event.index);
            yield {
              ...stamp(),
              type: EventType.REASONING_MESSAGE_END,
              messageId: reasoningId,
            };
            return;
          }
          const call = Option.getOrUndefined(MutableHashMap.get(streamingCalls, event.index));
          if (!isTruthy(call))
            throw SubscriptionStreamFailed.make({
              provider: providerName,
              reason: { _tag: "InvalidBlockEnd" },
            });
          MutableHashMap.remove(streamingCalls, event.index);
          yield {
            ...stamp(),
            type: EventType.TOOL_CALL_END,
            toolCallId: call.id,
            toolCallName: call.name,
          };
        };

        const events = Stream.suspend(() => {
          const body = subscriptionRequest({
            provider: this.name,
            selection: this.#selection,
            options: options,
          });
          const baselineBody = subscriptionRequest({
            provider: this.name,
            selection: this.#selection,
            options: options,
            requestOptions: {
              promptCache: "disabled",
            },
          });
          const fingerprints = requestFingerprints(options);
          options.logger.request("subscription model request", {
            provider: this.name,
            model: this.model,
            messages: options.messages.length,
            tools: options.tools?.length ?? 0,
            ...fingerprints,
          });

          return providerEventsWithPromptCacheFallback(
            this.#client,
            this.name,
            body,
            baselineBody,
            signal,
            () =>
              options.logger.provider(
                "subscription prompt cache rejected; retrying baseline request",
                { provider: this.name },
              ),
          ).pipe(
            Stream.takeWhile(() => signal?.aborted !== true),
            Stream.flatMap((event) => Stream.fromIterable(translate(event))),
            Stream.catchCause((cause) => {
              if (signal?.aborted === true) return Stream.empty;
              const squashed = Cause.squash(cause);
              const error = squashed instanceof Cause.UnknownError ? squashed.cause : squashed;
              // Native transport/SDK edge: never publish provider-controlled error text.
              const failure =
                Schema.is(ReasoningSummaryProtocolFailed)(error) ||
                Schema.is(SubscriptionStreamFailed)(error) ||
                error instanceof ProviderFeatureRejectedError
                  ? error
                  : SubscriptionStreamFailed.make({
                      provider: this.name,
                      reason: { _tag: "TransportUnavailable" },
                    });
              options.logger.errors("subscription model request failed", {
                provider: this.name,
                code: failure._tag,
              });
              return Stream.fail(failure);
            }),
          );
        });
        const finish = Stream.suspend(() =>
          Stream.fromIterable(
            (function* (): Generator<AdapterYieldChunk, void, unknown> {
              if (signal?.aborted === true) return;
              if (openSummaries > 0)
                throw ReasoningSummaryProtocolFailed.make({
                  reason: { _tag: "IncompleteSummary" },
                });
              if (
                MutableHashMap.size(streamingCalls) > 0 ||
                MutableHashMap.size(streamingReasoning) > 0
              )
                throw SubscriptionStreamFailed.make({
                  provider: providerName,
                  reason: { _tag: "IncompleteBlocks" },
                });
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
            })(),
          ),
        );
        return Stream.concat(
          Stream.make({
            ...stamp(),
            type: EventType.RUN_STARTED,
            runId,
            threadId,
          }),
          Stream.concat(events, finish),
        );
      }),
    );
  }

  structuredOutput(
    _options: StructuredOutputOptions<Record<string, never>>,
  ): Promise<StructuredOutputResult<never>> {
    return Promise.reject(
      new Error("Subscription adapters do not support separate structured output."),
    );
  }
}
