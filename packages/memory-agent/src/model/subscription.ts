import {
  Data,
  Effect,
  type JsonSchema,
  Match,
  MutableHashMap,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import {
  NormalizedStreamEvent,
  ProviderFeatureRejectedError,
  ProviderStatusRejected,
  ProviderStreamFailed,
  ReasoningSummaryProtocolFailed,
  ReasoningSummaryProtocolFailedReason,
  RequestNotSent,
  ToolArguments,
  type OAuthProvider,
} from "../oauth/protocol.ts";
import { optionalProperty } from "../optional-property.ts";
import type { ModelSelection, SubscriptionModelSelection } from "../providers/contracts.ts";
import { providerToolFunction } from "../providers/provider-tools.ts";
import { providerPrompt } from "./history.ts";
import { optionsKey, partOptions, toolResultContent, type StoredContent } from "./prompt.ts";
import { collectResponse } from "./response.ts";
import { toolParameters } from "./tool-schema.ts";

/**
 * The ChatGPT and Claude subscription models as an Effect `LanguageModel`. The request body is the
 * one the TanStack adapter (`providers/subscription-adapter.ts`) sent for the same history, and the
 * stream fails with the same typed reasons, carried in the `AiError` (`subscriptionFailure`).
 */

export interface StreamingOAuthClient {
  readonly releaseRun?: () => void;
  stream(body: string, signal?: AbortSignal): AsyncGenerator<NormalizedStreamEvent>;
}

const openAiReasoningPrefix = "openai-reasoning:";
const maxEncryptedReasoningCharacters = 32 * 1024 * 1024;
export const publicReasoningLimits = {
  characters: 2 * 1024 * 1024,
  parts: 256,
  idCharacters: 512,
} as const;

export const SubscriptionStreamFailedReason = Schema.TaggedUnion({
  ProviderRejected: {},
  RequestNotSent: { stage: RequestNotSent.fields.stage },
  ProviderStatusRejected: { statusClass: ProviderStatusRejected.fields.statusClass },
  ResponseInterrupted: {},
  RequestOutcomeUnknown: {},
  InvalidReasoning: {},
  InvalidToolCall: {},
  InvalidBlockEnd: {},
  IncompleteBlocks: {},
  EncryptedReasoningLimit: {},
});

export class SubscriptionStreamFailed extends Schema.TaggedError<SubscriptionStreamFailed>()(
  "SubscriptionStreamFailed",
  {
    provider: Schema.Literals(["openai", "anthropic"]),
    reason: SubscriptionStreamFailedReason,
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
const decodeOpenAiReasoningJson = Schema.decodeOption(Schema.fromJsonString(OpenAiReasoning));
/** The reasoning item packed in a thinking signature; null for any other signature. */
const decodeOpenAiReasoning = (signature: string) =>
  signature.startsWith(openAiReasoningPrefix)
    ? Option.getOrNull(
        decodeOpenAiReasoningJson(
          Buffer.from(signature.slice(openAiReasoningPrefix.length), "base64url").toString("utf8"),
        ),
      )
    : null;
const encodeOpenAiReasoning = (id: string, encryptedContent: string) =>
  `${openAiReasoningPrefix}${Buffer.from(JSON.stringify({ id, encryptedContent }), "utf8").toString(
    "base64url",
  )}`;

const decodeToolInput = Schema.decodeOption(Schema.fromJsonString(ToolArguments));
/** Anthropic `tool_use.input`: the arguments as an object, or `{}` when they do not parse. */
const toolInput = (serialized: string): ToolArguments =>
  Option.getOrElse(decodeToolInput(serialized), () => ({}));

/** Models whose adaptive thinking cannot be turned off and is bound to the request prefix. */
const anthropicThinkingAlwaysOn = (model: string) =>
  /^claude-(?:opus-5-5|fable-5-1)(?:-\d{8})?(?:\[1m\])?$/.test(model);

/** How long the provider keeps the request prefix cached, and the cache key. */
export const PromptCache = Schema.Struct({
  retention: Schema.Literals(["none", "short", "long"]),
  key: Schema.optionalKey(Schema.String),
});
export type PromptCache = typeof PromptCache.Type;

/** The Anthropic marker for each prompt cache retention, as TanStack's `anthropicText` sends it. */
const anthropicCacheControl = {
  short: { type: "ephemeral" },
  long: { type: "ephemeral", ttl: "1h" },
} as const;
type AnthropicCacheControl = (typeof anthropicCacheControl)[keyof typeof anthropicCacheControl];
const anthropicCacheControlFor = (retention: PromptCache["retention"] = "none") =>
  retention === "none" ? undefined : anthropicCacheControl[retention];

type ImageBlock = {
  readonly type: "image";
  readonly source:
    | { readonly type: "base64"; readonly media_type: string; readonly data: string }
    | { readonly type: "url"; readonly url: string };
};
type AnthropicContentBlock = { readonly type: "text"; readonly text: string } | ImageBlock;
type AnthropicBlock =
  | AnthropicContentBlock
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string | undefined;
      readonly content: string;
      readonly is_error: boolean;
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: ToolArguments;
    };

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<AnthropicBlock>;
}

/** Appends blocks to the last message when it has the same role, as Anthropic needs turns to alternate. */
const appendAnthropicMessage = (
  output: AnthropicMessage[],
  role: AnthropicMessage["role"],
  blocks: ReadonlyArray<AnthropicBlock>,
) => {
  if (blocks.length === 0) return;
  const previous = output.at(-1);
  if (previous?.role === role) {
    output[output.length - 1] = { role, content: [...previous.content, ...blocks] };
    return;
  }
  output.push({ role, content: blocks });
};

/** Block types that can carry the marker as the last block of the last user message. */
const isAnthropicCacheableBlock = Schema.is(Schema.Literals(["text", "image", "tool_result"]));

/** Marks the last user block, so the next request reads the whole conversation from the cache. */
const markLastUserBlock = (
  messages: ReadonlyArray<AnthropicMessage>,
  cacheControl: AnthropicCacheControl,
) => {
  const last = messages.at(-1);
  const block = last?.content.at(-1);
  if (last?.role !== "user" || block === undefined || !isAnthropicCacheableBlock(block.type))
    return messages;
  return [
    ...messages.slice(0, -1),
    {
      role: last.role,
      content: [...last.content.slice(0, -1), { ...block, cache_control: cacheControl }],
    },
  ];
};

/** The Responses cache key, cut to its 64-character limit; none when caching is off. */
const openAiPromptCacheKey = (promptCache: PromptCache | undefined) =>
  promptCache === undefined || promptCache.retention === "none" || promptCache.key === undefined
    ? undefined
    : Array.from(promptCache.key).slice(0, 64).join("");

const isPromptCacheRejection = (event: NormalizedStreamEvent) =>
  NormalizedStreamEvent.$is("error")(event) &&
  /cache[_ -]?control|prompt[_ -]?cach/i.test(`${event.code} ${event.message}`) &&
  /invalid|unsupported|unknown|not (?:allowed|supported)|unrecognized/i.test(
    `${event.code} ${event.message}`,
  );

/** The event's tag, which is all the stream log says about the event. */
const streamEventType = NormalizedStreamEvent.$match({
  text: () => "text",
  "tool-call": () => "tool-call",
  "tool-call-start": () => "tool-call-start",
  "tool-call-arguments": () => "tool-call-arguments",
  "content-block-end": () => "content-block-end",
  "reasoning-start": () => "reasoning-start",
  "reasoning-delta": () => "reasoning-delta",
  "reasoning-signature": () => "reasoning-signature",
  reasoning: () => "reasoning",
  "reasoning-summary-start": () => "reasoning-summary-start",
  "reasoning-summary-delta": () => "reasoning-summary-delta",
  "reasoning-summary-end": () => "reasoning-summary-end",
  usage: () => "usage",
  error: () => "error",
});

/** A public reasoning summary part: still receiving text, or ended. */
type SummaryState = Data.TaggedEnum<{
  open: { readonly text: string };
  closed: {};
}>;
const SummaryState = Data.taggedEnum<SummaryState>();

export type SubscriptionFailure =
  | SubscriptionStreamFailed
  | ProviderFeatureRejectedError
  | ReasoningSummaryProtocolFailed;

// A thrown value from the native client is classified only by its type and stream position.
const streamFailure = (
  provider: OAuthProvider,
  cause: unknown,
  received: boolean,
): SubscriptionFailure => {
  if (
    Schema.is(ProviderFeatureRejectedError)(cause) ||
    Schema.is(SubscriptionStreamFailed)(cause) ||
    Schema.is(ReasoningSummaryProtocolFailed)(cause)
  )
    return cause;
  if (received)
    return SubscriptionStreamFailed.make({
      provider,
      reason: SubscriptionStreamFailedReason.cases.ResponseInterrupted.make({}),
    });
  return SubscriptionStreamFailed.make({
    provider,
    reason: Schema.is(ProviderStreamFailed)(cause)
      ? cause.reason
      : SubscriptionStreamFailedReason.cases.RequestOutcomeUnknown.make({}),
  });
};

/** The failure's tag, which is all the error log says about it. */
const streamFailureCode = Match.typeTags<SubscriptionFailure, string>()({
  SubscriptionStreamFailed: () => "SubscriptionStreamFailed",
  ProviderFeatureRejectedError: () => "ProviderFeatureRejectedError",
  ReasoningSummaryProtocolFailed: () => "ReasoningSummaryProtocolFailed",
});

/**
 * The provider's events for `body`. When Anthropic rejects the prompt-cache feature before any
 * event, `onFallback` runs and `baselineBody`, the request without caching, goes once instead.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
function providerEventsWithPromptCacheFallback(options: {
  readonly client: StreamingOAuthClient;
  readonly provider: OAuthProvider;
  readonly body: string;
  readonly baselineBody: string;
  readonly signal: AbortSignal | undefined;
  readonly onFallback: Effect.Effect<void>;
}) {
  const { client, provider, signal } = options;
  return Stream.suspend(() => {
    let emitted = false;
    const source = (request: string) =>
      Stream.suspend(() => {
        let received = false;
        return Stream.fromAsyncIterable(client.stream(request, signal), (cause) =>
          streamFailure(provider, cause, received),
        ).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              received = true;
            }),
          ),
        );
      });
    return source(options.body).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          if (provider === "anthropic" && isPromptCacheRejection(event))
            return yield* ProviderFeatureRejectedError.make({
              provider: "anthropic",
              feature: "prompt-cache",
              status: null,
            });
          emitted = true;
          return event;
        }),
      ),
      Stream.catchTag("ProviderFeatureRejectedError", (failure) => {
        if (provider !== "anthropic" || emitted || failure.feature !== "prompt-cache")
          return Stream.fail(failure);
        return Stream.unwrap(Effect.as(options.onFallback, source(options.baselineBody)));
      }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------

type OpenAiBlock =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "output_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string };

type OpenAiItem =
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string }
  | {
      readonly type: "reasoning";
      readonly id: string;
      readonly summary: readonly [];
      readonly encrypted_content: string;
    }
  | {
      readonly type: "message";
      readonly role: "user" | "assistant";
      readonly content: ReadonlyArray<OpenAiBlock>;
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    };

/** The text of stored tool or user content; images add nothing. */
const textOf = (content: StoredContent) =>
  Predicate.isString(content)
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");

/** File data as `toPrompt` keeps it: base64 or, with the `url` option, a URL. */
const imageSource = (part: Prompt.FilePart) => {
  if (part.data instanceof URL) return { type: "url", url: part.data.toString() } as const;
  if (part.data instanceof Uint8Array)
    return { type: "base64", base64: Buffer.from(part.data).toString("base64") } as const;
  return partOptions(part).url === true
    ? ({ type: "url", url: part.data } as const)
    : ({ type: "base64", base64: part.data } as const);
};

const anthropicImage = (part: Prompt.FilePart): ImageBlock => {
  const source = imageSource(part);
  return {
    type: "image",
    source:
      source.type === "url"
        ? { type: "url", url: source.url }
        : { type: "base64", media_type: part.mediaType, data: source.base64 },
  };
};

const openAiImage = (part: Prompt.FilePart): OpenAiBlock => {
  const source = imageSource(part);
  return {
    type: "input_image",
    image_url:
      source.type === "url" ? source.url : `data:${part.mediaType};base64,${source.base64}`,
  };
};

/** The arguments as the model sent them; the encoded parameters for a call made elsewhere. */
const callArguments = (part: Prompt.ToolCallPart) =>
  partOptions(part).arguments ?? JSON.stringify(part.params);

const anthropicMessages = (prompt: Prompt.Prompt) => {
  const output: AnthropicMessage[] = [];
  for (const message of prompt.content)
    switch (message.role) {
      case "system":
        break;
      case "tool":
        appendAnthropicMessage(
          output,
          "user",
          message.content.flatMap((part) =>
            part.type === "tool-result"
              ? [
                  {
                    type: "tool_result" as const,
                    tool_use_id: part.id,
                    content: textOf(toolResultContent(part)),
                    is_error: part.isFailure,
                  },
                ]
              : [],
          ),
        );
        break;
      case "user":
        appendAnthropicMessage(
          output,
          "user",
          message.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : anthropicImage(part),
          ),
        );
        break;
      case "assistant": {
        const thinking: AnthropicBlock[] = [];
        const content: AnthropicBlock[] = [];
        const calls: AnthropicBlock[] = [];
        for (const part of message.content)
          switch (part.type) {
            case "reasoning": {
              const { signature } = partOptions(part);
              if (signature !== undefined && decodeOpenAiReasoning(signature) === null)
                thinking.push({ type: "thinking", thinking: part.text, signature });
              break;
            }
            case "text":
              content.push({ type: "text", text: part.text });
              break;
            case "tool-call":
              if (!part.providerExecuted)
                calls.push({
                  type: "tool_use",
                  id: part.id,
                  name: part.name,
                  input: toolInput(callArguments(part)),
                });
              break;
          }
        appendAnthropicMessage(output, "assistant", [...thinking, ...content, ...calls]);
        break;
      }
    }
  return output;
};

const openAiInput = (prompt: Prompt.Prompt) => {
  const input: OpenAiItem[] = [];
  for (const message of prompt.content) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      for (const part of message.content)
        if (part.type === "tool-result")
          input.push({
            type: "function_call_output",
            call_id: part.id,
            output: textOf(toolResultContent(part)),
          });
      continue;
    }
    const textType = message.role === "assistant" ? "output_text" : "input_text";
    const content: OpenAiBlock[] = [];
    const calls: OpenAiItem[] = [];
    for (const part of message.content)
      switch (part.type) {
        case "reasoning": {
          const { signature } = partOptions(part);
          const reasoning = signature === undefined ? null : decodeOpenAiReasoning(signature);
          if (reasoning !== null)
            input.push({
              type: "reasoning",
              id: reasoning.id,
              summary: [],
              encrypted_content: reasoning.encryptedContent,
            });
          break;
        }
        case "text":
          content.push({ type: textType, text: part.text });
          break;
        case "file":
          content.push(openAiImage(part));
          break;
        case "tool-call":
          if (!part.providerExecuted)
            calls.push({
              type: "function_call",
              call_id: part.id,
              name: part.name,
              arguments: callArguments(part),
            });
          break;
      }
    if (content.length > 0) input.push({ type: "message", role: message.role, content });
    input.push(...calls);
  }
  return input;
};

const systemText = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n\n");

const canonicalTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools
    .map((tool): { name: string; description?: string; input_schema: JsonSchema.JsonSchema } =>
      Option.getOrElse(providerToolFunction(tool), () => ({
        name: tool.name,
        ...optionalProperty("description", Tool.getDescription(tool)),
        input_schema: toolParameters(tool),
      })),
    )
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

/** What a subscription request is made of. */
export interface SubscriptionRequest {
  readonly provider: OAuthProvider;
  readonly selection: ModelSelection;
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
  readonly promptCache: PromptCache | undefined;
}

/** The request body, which the client sends as it is. */
export const subscriptionBody = (request: SubscriptionRequest) => {
  const { provider, selection, prompt } = request;
  const system = systemText(prompt);
  const tools = canonicalTools(request.tools);
  if (provider === "anthropic") {
    const cacheControl = anthropicCacheControlFor(request.promptCache?.retention);
    const messages = anthropicMessages(prompt);
    return JSON.stringify({
      model: selection.model,
      max_tokens: 32_000,
      stream: true,
      system:
        cacheControl !== undefined && system.length > 0
          ? [{ type: "text", text: system, cache_control: cacheControl }]
          : system,
      messages: cacheControl === undefined ? messages : markLastUserBlock(messages, cacheControl),
      tools: tools.map((tool, index) =>
        cacheControl !== undefined && index === tools.length - 1
          ? { ...tool, cache_control: cacheControl }
          : tool,
      ),
      tool_choice: tools.length > 0 ? { type: "auto" } : undefined,
      thinking: anthropicThinkingAlwaysOn(selection.model)
        ? {
            type: "adaptive",
            // Without an explicit display these models return empty thinking blocks.
            display: "summarized",
            // Drop signed thinking whose prefix changed (compaction, model switch,
            // system or tool changes) instead of rejecting the whole request.
            block_binding: { prefix_mismatch_behavior: "drop_block" },
          }
        : undefined,
      output_config:
        selection.reasoningEffort === "none" ? undefined : { effort: selection.reasoningEffort },
    });
  }
  // The ChatGPT Responses subscription endpoint takes `prompt_cache_key` for cache routing (jcode
  // sends its session id there). It has no confirmed contract for the retention fields, so a
  // `'long'` retention still sends only the key and relies on the provider's automatic cache.
  return JSON.stringify({
    model: selection.model,
    instructions: system,
    input: openAiInput(prompt),
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
    prompt_cache_key: openAiPromptCacheKey(request.promptCache),
    stream: true,
    store: false,
  });
};

// A digest of bytes in memory cannot fail; a failure is a defect of the runtime.
const sha256 = (serialized: string) =>
  oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(serialized)).pipe(
    Effect.map((digest) => Buffer.from(digest).toString("hex")),
    Effect.orDie,
  );

/** The text the request log hashes: the history, and the tools in their sent order. */
const fingerprintSources = (prompt: Prompt.Prompt, tools: ReadonlyArray<Tool.Any>) => ({
  messages: JSON.stringify({ system: systemText(prompt), messages: openAiInput(prompt) }),
  tools: JSON.stringify(canonicalTools(tools)),
});

/** Hashes of the history and of the tools, which the request log carries instead of their text. */
const requestFingerprints = (request: LanguageModel.ProviderOptions) => {
  const sources = fingerprintSources(request.prompt, request.tools);
  return Effect.all({
    messageFingerprint: sha256(sources.messages),
    toolFingerprint: sha256(sources.tools),
  });
};

// ---------------------------------------------------------------------------------------------
// Response stream
// ---------------------------------------------------------------------------------------------

type Part = Response.StreamPartEncoded;

const decodeArguments = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
// Arguments the provider decoded from JSON encode back to JSON.
const encodeToolArguments = (args: ToolArguments) =>
  Effect.orDie(Schema.encodeEffect(Schema.fromJsonString(ToolArguments))(args));
/** The parameters of streamed arguments; arguments that do not parse stay text for the caller. */
const paramsOf = (serialized: string) =>
  Option.getOrElse(decodeArguments(serialized === "" ? "{}" : serialized), () => serialized);

/** Stream part metadata this app reads: the signature, or the arguments as the model sent them. */
const metadata = (value: { readonly signature?: string; readonly arguments?: string }) => ({
  metadata: { [optionsKey]: value },
});

/**
 * Turns provider events into response parts, one event at a time, and checks the block protocol.
 * OpenAI sends its encrypted reasoning right after the summary it belongs to, so a summary's end
 * waits for the next event: encrypted reasoning puts its signature on that end, as TanStack put it
 * on the current thinking step. Encrypted reasoning after anything else is a block without text.
 */
const makeTranslator = (provider: OAuthProvider) => {
  const failed = (reason: SubscriptionStreamFailed["reason"]) =>
    SubscriptionStreamFailed.make({ provider, reason });
  const summaryFailed = (reason: ReasoningSummaryProtocolFailed["reason"]) =>
    ReasoningSummaryProtocolFailed.make({ reason });
  let textId: string | undefined;
  let texts = 0;
  let toolCalls = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedPromptTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  const streamingCalls = MutableHashMap.empty<
    number,
    { readonly id: string; readonly name: string; arguments: string }
  >();
  const streamingReasoning = MutableHashMap.empty<
    number,
    { readonly id: string; signature: string | undefined }
  >();
  let summaryCharacters = 0;
  let summaryCount = 0;
  let openSummaries = 0;
  const summaries = MutableHashMap.empty<string, SummaryState>();
  /** The summary whose end waits for its encrypted reasoning. */
  let endingSummary: string | undefined;

  const closeText = (): Array<Part> => {
    if (textId === undefined) return [];
    const id = textId;
    textId = undefined;
    return [{ type: "text-end", id }];
  };

  const endSummary = (signature?: string): Array<Part> => {
    if (endingSummary === undefined) return [];
    const id = endingSummary;
    endingSummary = undefined;
    return [{ type: "reasoning-end", id, ...metadata(optionalProperty("signature", signature)) }];
  };

  const step = (event: NormalizedStreamEvent): Effect.Effect<Array<Part>, SubscriptionFailure> => {
    const ended =
      NormalizedStreamEvent.$is("usage")(event) || NormalizedStreamEvent.$is("reasoning")(event)
        ? []
        : endSummary();
    return Effect.map(translate(event), (parts) => [...ended, ...parts]);
  };

  const translate = (
    event: NormalizedStreamEvent,
  ): Effect.Effect<Array<Part>, SubscriptionFailure> =>
    Effect.gen(function* () {
      if (NormalizedStreamEvent.$is("usage")(event)) {
        promptTokens = event.promptTokens ?? promptTokens;
        completionTokens = event.completionTokens ?? completionTokens;
        cachedPromptTokens = event.cachedPromptTokens ?? cachedPromptTokens;
        cacheWriteTokens = event.cacheWriteTokens ?? cacheWriteTokens;
        return [];
      }
      if (NormalizedStreamEvent.$is("error")(event))
        return yield* failed(SubscriptionStreamFailedReason.cases.ProviderRejected.make({}));
      // Public OpenAI summary parts are reasoning blocks of their own, not Anthropic block ends.
      if (NormalizedStreamEvent.$is("reasoning-summary-start")(event)) {
        const summaryId = `reasoning-summary-${event.id}-${event.summaryIndex}`;
        if (MutableHashMap.has(summaries, summaryId))
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({}),
          );
        if (
          summaryCount >= publicReasoningLimits.parts ||
          event.id.length > publicReasoningLimits.idCharacters ||
          summaryCharacters + event.text.length > publicReasoningLimits.characters
        )
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.ResourceLimit.make({}),
          );
        summaryCount++;
        openSummaries++;
        summaryCharacters += event.text.length;
        MutableHashMap.set(summaries, summaryId, SummaryState.open({ text: event.text }));
        return [
          { type: "reasoning-start", id: summaryId },
          ...(event.text.length > 0
            ? [{ type: "reasoning-delta" as const, id: summaryId, delta: event.text }]
            : []),
        ];
      }
      if (
        NormalizedStreamEvent.$is("reasoning-summary-delta")(event) ||
        NormalizedStreamEvent.$is("reasoning-summary-end")(event)
      ) {
        const summaryId = `reasoning-summary-${event.id}-${event.summaryIndex}`;
        const summary = Option.getOrUndefined(MutableHashMap.get(summaries, summaryId));
        if (summary === undefined)
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({}),
          );
        if (SummaryState.$is("closed")(summary))
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.AlreadyEnded.make({}),
          );
        if (NormalizedStreamEvent.$is("reasoning-summary-delta")(event)) {
          if (summaryCharacters + event.delta.length > publicReasoningLimits.characters)
            return yield* summaryFailed(
              ReasoningSummaryProtocolFailedReason.cases.ResourceLimit.make({}),
            );
          summaryCharacters += event.delta.length;
          MutableHashMap.set(
            summaries,
            summaryId,
            SummaryState.open({ text: summary.text + event.delta }),
          );
          return [{ type: "reasoning-delta", id: summaryId, delta: event.delta }];
        }
        if (!event.text.startsWith(summary.text))
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({}),
          );
        const remaining = event.text.slice(summary.text.length);
        if (summaryCharacters + remaining.length > publicReasoningLimits.characters)
          return yield* summaryFailed(
            ReasoningSummaryProtocolFailedReason.cases.ResourceLimit.make({}),
          );
        summaryCharacters += remaining.length;
        openSummaries--;
        MutableHashMap.set(summaries, summaryId, SummaryState.closed());
        endingSummary = summaryId;
        return remaining.length > 0
          ? [{ type: "reasoning-delta", id: summaryId, delta: remaining }]
          : [];
      }
      if (NormalizedStreamEvent.$is("reasoning")(event)) {
        if (event.encryptedContent.length > maxEncryptedReasoningCharacters)
          return yield* failed(
            SubscriptionStreamFailedReason.cases.EncryptedReasoningLimit.make({}),
          );
        const signature = encodeOpenAiReasoning(event.id, event.encryptedContent);
        if (endingSummary !== undefined) return endSummary(signature);
        const id = `reasoning-encrypted-${event.id}`;
        return [
          { type: "reasoning-start", id },
          { type: "reasoning-end", id, ...metadata({ signature }) },
        ];
      }
      if (NormalizedStreamEvent.$is("text")(event)) {
        const opened: Array<Part> = [];
        if (textId === undefined) {
          textId = `text-${texts++}`;
          opened.push({ type: "text-start", id: textId });
        }
        return [...opened, { type: "text-delta", id: textId, delta: event.text }];
      }
      if (NormalizedStreamEvent.$is("content-block-end")(event) && textId !== undefined)
        return closeText();
      const closed = closeText();
      if (NormalizedStreamEvent.$is("tool-call")(event)) {
        toolCalls++;
        const serialized = yield* encodeToolArguments(event.arguments);
        return [
          ...closed,
          { type: "tool-params-start", id: event.id, name: event.name },
          { type: "tool-params-delta", id: event.id, delta: serialized },
          { type: "tool-params-end", id: event.id },
          {
            type: "tool-call",
            id: event.id,
            name: event.name,
            params: event.arguments,
            ...metadata({ arguments: serialized }),
          },
        ];
      }
      if (NormalizedStreamEvent.$is("tool-call-start")(event)) {
        if (
          MutableHashMap.has(streamingCalls, event.index) ||
          MutableHashMap.has(streamingReasoning, event.index)
        )
          return yield* failed(SubscriptionStreamFailedReason.cases.InvalidToolCall.make({}));
        MutableHashMap.set(streamingCalls, event.index, {
          id: event.id,
          name: event.name,
          arguments: "",
        });
        toolCalls++;
        return [...closed, { type: "tool-params-start", id: event.id, name: event.name }];
      }
      if (NormalizedStreamEvent.$is("reasoning-start")(event)) {
        if (
          MutableHashMap.has(streamingReasoning, event.index) ||
          MutableHashMap.has(streamingCalls, event.index)
        )
          return yield* failed(SubscriptionStreamFailedReason.cases.InvalidReasoning.make({}));
        const id = `reasoning-${event.index}`;
        MutableHashMap.set(streamingReasoning, event.index, { id, signature: undefined });
        return [...closed, { type: "reasoning-start", id }];
      }
      if (
        NormalizedStreamEvent.$is("reasoning-delta")(event) ||
        NormalizedStreamEvent.$is("reasoning-signature")(event)
      ) {
        const reasoning = Option.getOrUndefined(
          MutableHashMap.get(streamingReasoning, event.index),
        );
        if (reasoning === undefined)
          return yield* failed(SubscriptionStreamFailedReason.cases.InvalidReasoning.make({}));
        if (NormalizedStreamEvent.$is("reasoning-signature")(event)) {
          reasoning.signature = event.signature;
          return closed;
        }
        return [...closed, { type: "reasoning-delta", id: reasoning.id, delta: event.delta }];
      }
      if (NormalizedStreamEvent.$is("tool-call-arguments")(event)) {
        const call = Option.getOrUndefined(MutableHashMap.get(streamingCalls, event.index));
        if (call === undefined)
          return yield* failed(SubscriptionStreamFailedReason.cases.InvalidToolCall.make({}));
        call.arguments += event.delta;
        return [...closed, { type: "tool-params-delta", id: call.id, delta: event.delta }];
      }
      const reasoning = Option.getOrUndefined(MutableHashMap.get(streamingReasoning, event.index));
      if (reasoning !== undefined) {
        MutableHashMap.remove(streamingReasoning, event.index);
        return [
          ...closed,
          {
            type: "reasoning-end",
            id: reasoning.id,
            ...metadata(optionalProperty("signature", reasoning.signature)),
          },
        ];
      }
      const call = Option.getOrUndefined(MutableHashMap.get(streamingCalls, event.index));
      if (call === undefined)
        return yield* failed(SubscriptionStreamFailedReason.cases.InvalidBlockEnd.make({}));
      MutableHashMap.remove(streamingCalls, event.index);
      return [
        ...closed,
        { type: "tool-params-end", id: call.id },
        {
          type: "tool-call",
          id: call.id,
          name: call.name,
          params: paramsOf(call.arguments),
          ...metadata({ arguments: call.arguments }),
        },
      ];
    });

  const finish = Effect.suspend((): Effect.Effect<Array<Part>, SubscriptionFailure> => {
    if (openSummaries > 0)
      return Effect.fail(
        summaryFailed(ReasoningSummaryProtocolFailedReason.cases.IncompleteSummary.make({})),
      );
    if (MutableHashMap.size(streamingCalls) > 0 || MutableHashMap.size(streamingReasoning) > 0)
      return Effect.fail(failed(SubscriptionStreamFailedReason.cases.IncompleteBlocks.make({})));
    const uncached =
      promptTokens === undefined
        ? undefined
        : promptTokens - (cachedPromptTokens ?? 0) - (cacheWriteTokens ?? 0);
    return Effect.succeed([
      ...endSummary(),
      ...closeText(),
      {
        type: "finish",
        reason: toolCalls > 0 ? "tool-calls" : "stop",
        usage: {
          inputTokens: {
            ...optionalProperty("total", promptTokens),
            ...optionalProperty("uncached", uncached),
            ...optionalProperty("cacheRead", cachedPromptTokens),
            ...optionalProperty("cacheWrite", cacheWriteTokens),
          },
          outputTokens: optionalProperty("total", completionTokens),
        },
      },
    ]);
  });

  return { step, finish };
};

// ---------------------------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------------------------

/** The typed failure in the `AiError` a subscription model fails with. */
const SubscriptionFailureSchema = Schema.Union([
  SubscriptionStreamFailed,
  ProviderFeatureRejectedError,
  ReasoningSummaryProtocolFailed,
]);
const decodeFailure = Schema.decodeUnknownOption(SubscriptionFailureSchema);

const toAiError = (failure: SubscriptionFailure) =>
  Schema.encodeEffect(SubscriptionFailureSchema)(failure).pipe(
    Effect.orDie,
    Effect.map((encoded) =>
      AiError.make({
        module: "SubscriptionLanguageModel",
        method: "streamText",
        reason: AiError.UnknownError.make({
          description: failure.message,
          metadata: { [optionsKey]: encoded },
        }),
      }),
    ),
  );

/** The subscription failure an `AiError` from a subscription model carries. */
export const subscriptionFailure = (error: AiError.AiError): Option.Option<SubscriptionFailure> =>
  error.reason._tag === "UnknownError"
    ? decodeFailure(error.reason.metadata[optionsKey])
    : Option.none();

const unsupported = (description: string) =>
  AiError.make({
    module: "SubscriptionLanguageModel",
    method: "streamText",
    reason: AiError.InvalidRequestError.make({ description }),
  });

/** One run's subscription model: its selection and prompt cache stay fixed for every step. */
export interface SubscriptionModelOptions {
  readonly client: StreamingOAuthClient;
  readonly selection: SubscriptionModelSelection;
  readonly promptCache: PromptCache | undefined;
}

export const makeSubscriptionModel = Effect.fnUntraced(function* (
  options: SubscriptionModelOptions,
) {
  const { client, selection } = options;
  const provider = selection.provider;
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (request.responseFormat.type === "json")
          return yield* unsupported("Subscription models do not support structured output.");
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (aborted) => Effect.sync(() => aborted.abort()),
        );
        // Subscription providers read another model's turns as their own: no replay target.
        const replayed = { ...request, prompt: providerPrompt(request.prompt, undefined) };
        const body = subscriptionBody({ ...options, provider, ...replayed });
        const baselineBody = subscriptionBody({
          ...options,
          provider,
          ...replayed,
          promptCache: { retention: "none" },
        });
        const fingerprints = yield* requestFingerprints(replayed);
        yield* Effect.logDebug("subscription model request").pipe(
          Effect.annotateLogs({
            provider,
            model: selection.model,
            messages: replayed.prompt.content.length,
            tools: request.tools.length,
            ...fingerprints,
          }),
        );
        const translator = makeTranslator(provider);
        return providerEventsWithPromptCacheFallback({
          client,
          provider,
          body,
          baselineBody,
          signal: controller.signal,
          onFallback: Effect.logDebug(
            "subscription prompt cache rejected; retrying baseline request",
          ).pipe(Effect.annotateLogs({ provider })),
        }).pipe(
          Stream.tap((event) =>
            Effect.logTrace("subscription stream event").pipe(
              Effect.annotateLogs({ provider, eventType: streamEventType(event) }),
            ),
          ),
          Stream.mapEffect(translator.step),
          Stream.concat(Stream.fromEffect(translator.finish)),
          Stream.flatMap(Stream.fromIterable),
          Stream.catch((failure: SubscriptionFailure) =>
            Stream.fromEffect(
              Effect.logError("subscription model request failed").pipe(
                // Native transport/SDK edge: never publish provider-controlled error text.
                Effect.annotateLogs({ provider, code: streamFailureCode(failure) }),
                Effect.andThen(toAiError(failure)),
                Effect.flatMap(Effect.fail),
              ),
            ),
          ),
        );
      }),
    );
  return yield* LanguageModel.make({
    streamText,
    generateText: (request) => collectResponse(streamText(request)),
  });
});
