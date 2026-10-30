import {
  Array as Arr,
  Data,
  Effect,
  HashMap,
  type JsonSchema,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { failureNameOf } from "../runtime/failure-tag.ts";
import { sha256 } from "../runtime/synchronous-crypto.ts";
import {
  boundedErrorDetail,
  NormalizedStreamEvent,
  ProviderErrorDetail,
  ProviderFeatureRejectedError,
  ProviderStatusRejected,
  ReasoningSummaryProtocolFailed,
  ReasoningSummaryProtocolFailedReason,
  RequestNotSent,
  ToolArguments,
  type OAuthProvider,
} from "../oauth/protocol.ts";
import type { SubscriptionClientFailure } from "../oauth/validation-harness.ts";
import { optionalProperty } from "../optional-property.ts";
import type {
  ModelSelection,
  ShownFailure,
  SubscriptionModelSelection,
} from "../providers/contracts.ts";
import { providerToolFunction } from "../providers/provider-tools.ts";
import { providerPrompt } from "./history.ts";
import { optionsKey, partOptions, toolResultContent, type StoredContent } from "./prompt.ts";
import { collectResponse } from "./response.ts";
import { shownReason } from "./shown-failure.ts";
import { toolParameters } from "./tool-schema.ts";

/**
 * The ChatGPT and Claude subscription models as an Effect `LanguageModel`. The request body is the
 * one the removed TanStack adapter sent for the same history, as the golden requests under
 * `tests/model/__golden__` keep it, and the stream fails with the same typed reasons, carried in
 * the `AiError` (`subscriptionFailure`).
 */

export interface StreamingOAuthClient {
  readonly stream: (
    body: string,
  ) => Stream.Stream<NormalizedStreamEvent, SubscriptionClientFailure>;
}

const openAiReasoningPrefix = "openai-reasoning:";
const maxEncryptedReasoningCharacters = 32 * 1024 * 1024;
export const publicReasoningLimits = {
  characters: 2 * 1024 * 1024,
  parts: 256,
  idCharacters: 512,
} as const;

export const SubscriptionStreamFailedReason = Schema.TaggedUnion({
  /** The provider sent an error event in the stream. */
  ProviderRejected: { error: ProviderErrorDetail },
  RequestNotSent: { stage: RequestNotSent.fields.stage },
  ProviderStatusRejected: {
    statusClass: ProviderStatusRejected.fields.statusClass,
    status: ProviderStatusRejected.fields.status,
    error: ProviderStatusRejected.fields.error,
    requestId: ProviderStatusRejected.fields.requestId,
  },
  ResponseInterrupted: {},
  RequestOutcomeUnknown: {},
  InvalidReasoning: {},
  InvalidToolCall: {},
  InvalidBlockEnd: {},
  IncompleteBlocks: {},
  EncryptedReasoningLimit: {},
});

const providerNames = {
  openai: "OpenAI",
  anthropic: "Anthropic",
} as const satisfies Record<OAuthProvider, string>;

/** The provider's own words after the app's: `invalid_request_error: messages: …`. */
const providerWords = (error: ProviderErrorDetail | null) =>
  error === null ? "" : `: ${error.type}: ${error.message}`;

export class SubscriptionStreamFailed extends Schema.TaggedError<
  SubscriptionStreamFailed,
  { readonly brand: unique symbol }
>()("SubscriptionStreamFailed", {
  provider: Schema.Literals(["openai", "anthropic"]),
  reason: SubscriptionStreamFailedReason,
}) {
  /** What the provider said when it rejected the request, as Claude Code's `API Error` shows it. */
  override get message() {
    const api = `${providerNames[this.provider]} API error`;
    return SubscriptionStreamFailedReason.matchOrElse(
      this.reason,
      {
        ProviderStatusRejected: ({ status, error, requestId }) =>
          `${api} ${status}${providerWords(error)}${
            requestId === null ? "" : ` (request ${requestId})`
          }`,
        ProviderRejected: ({ error }) => `${api}${providerWords(error)}`,
      },
      () => "Subscription provider stream failed.",
    );
  }
}

const OpenAiReasoning = Schema.Struct({
  id: Schema.String,
  encryptedContent: Schema.String,
});
const decodeOpenAiReasoningJson = Schema.decodeOption(Schema.fromJsonString(OpenAiReasoning));
/** The reasoning item packed in a thinking signature; none for any other signature. */
const decodeOpenAiReasoning = (signature: string) =>
  Option.liftPredicate(signature, (packed) => packed.startsWith(openAiReasoningPrefix)).pipe(
    Option.flatMap((packed) =>
      decodeOpenAiReasoningJson(
        Buffer.from(packed.slice(openAiReasoningPrefix.length), "base64url").toString("utf8"),
      ),
    ),
  );
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

/**
 * Models that think when the request does not ask for it, and by default show none of it: their
 * thinking blocks stream with empty text unless the request asks for a summary.
 */
const anthropicThinkingByDefault = (model: string) =>
  /^claude-(?:opus-5|sonnet-5(?:-5)?|haiku-5-5|fable-5)(?:-\d{8})?(?:\[1m\])?$/.test(model);

/** The thinking a subscription request asks for, or none to leave the model's own default. */
const anthropicThinking = (model: string) =>
  anthropicThinkingAlwaysOn(model)
    ? {
        type: "adaptive",
        // Without an explicit display these models return empty thinking blocks.
        display: "summarized",
        // Drop signed thinking whose prefix changed (compaction, model switch,
        // system or tool changes) instead of rejecting the whole request.
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      }
    : anthropicThinkingByDefault(model)
      ? { type: "adaptive", display: "summarized" }
      : undefined;

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
  output: ReadonlyArray<AnthropicMessage>,
  role: AnthropicMessage["role"],
  blocks: ReadonlyArray<AnthropicBlock>,
): ReadonlyArray<AnthropicMessage> =>
  blocks.length === 0
    ? output
    : Option.match(
        Option.filter(Arr.last(output), (previous) => previous.role === role),
        {
          onNone: () => [...output, { role, content: blocks }],
          onSome: (previous) => [
            ...output.slice(0, -1),
            { role, content: [...previous.content, ...blocks] },
          ],
        },
      );

/** Block types that can carry the marker as the last block of the last user message. */
const isAnthropicCacheableBlock = Schema.is(Schema.Literals(["text", "image", "tool_result"]));

/** Marks the last user block, so the next request reads the whole conversation from the cache. */
const markLastUserBlock = (
  messages: ReadonlyArray<AnthropicMessage>,
  cacheControl: AnthropicCacheControl,
) =>
  Option.filter(Arr.last(messages), (last) => last.role === "user").pipe(
    Option.flatMap((last) =>
      Option.filter(Arr.last(last.content), (block) => isAnthropicCacheableBlock(block.type)).pipe(
        Option.map((block) => [
          ...messages.slice(0, -1),
          {
            role: last.role,
            content: [...last.content.slice(0, -1), { ...block, cache_control: cacheControl }],
          },
        ]),
      ),
    ),
    Option.getOrElse(() => messages),
  );

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

// A client failure is classified only by its type and stream position.
const streamFailure = (
  provider: OAuthProvider,
  cause: SubscriptionClientFailure,
  received: boolean,
): SubscriptionFailure =>
  Match.value(cause).pipe(
    Match.tag("ProviderFeatureRejectedError", (failure): SubscriptionFailure => failure),
    Match.when(
      () => received,
      () =>
        SubscriptionStreamFailed.make({
          provider,
          reason: SubscriptionStreamFailedReason.cases.ResponseInterrupted.make({}),
        }),
    ),
    Match.tag("ProviderStreamFailed", (failure) =>
      SubscriptionStreamFailed.make({ provider, reason: failure.reason }),
    ),
    Match.tag("OAuthHarnessError", () =>
      SubscriptionStreamFailed.make({
        provider,
        reason: SubscriptionStreamFailedReason.cases.RequestOutcomeUnknown.make({}),
      }),
    ),
    Match.exhaustive,
  );

/** The class of the status a provider rejected the request with, when that is the failure. */
const rejectedStatusClass = (failure: SubscriptionFailure) =>
  Predicate.isTagged(failure, "SubscriptionStreamFailed") &&
  failure.reason._tag === "ProviderStatusRejected"
    ? [failure.reason.statusClass]
    : [];

/**
 * The failure's name and a rejected status's class, such as
 * `SubscriptionStreamFailed:ProviderStatusRejected:client_error`, for grouping log lines.
 */
const streamFailureCode = (failure: SubscriptionFailure) =>
  [failureNameOf(failure), ...rejectedStatusClass(failure)].join(":");

/**
 * The provider's events for `body`. When Anthropic rejects the prompt-cache feature before any
 * event, `onFallback` runs and `baselineBody`, the request without caching, goes once instead.
 */
function providerEventsWithPromptCacheFallback(options: {
  readonly client: StreamingOAuthClient;
  readonly provider: OAuthProvider;
  readonly body: string;
  readonly baselineBody: string;
  readonly onFallback: Effect.Effect<void>;
}) {
  const { client, provider } = options;
  const source = (request: string) =>
    Stream.unwrap(
      Effect.map(Ref.make(false), (received) =>
        client.stream(request).pipe(
          Stream.tap(() => Ref.set(received, true)),
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.flatMap(Ref.get(received), (seen) =>
                Effect.fail(streamFailure(provider, cause, seen)),
              ),
            ),
          ),
        ),
      ),
    );
  return Stream.unwrap(
    Effect.map(Ref.make(false), (emitted) =>
      source(options.body).pipe(
        Stream.mapEffect((event) =>
          provider === "anthropic" && isPromptCacheRejection(event)
            ? Effect.fail(
                ProviderFeatureRejectedError.make({
                  provider: "anthropic",
                  feature: "prompt-cache",
                  status: null,
                }),
              )
            : Effect.as(Ref.set(emitted, true), event),
        ),
        Stream.catchTag("ProviderFeatureRejectedError", (failure) =>
          Stream.unwrap(
            Effect.map(Ref.get(emitted), (seen) =>
              provider === "anthropic" && !seen && failure.feature === "prompt-cache"
                ? Stream.unwrap(Effect.as(options.onFallback, source(options.baselineBody)))
                : Stream.fail(failure),
            ),
          ),
        ),
      ),
    ),
  );
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
const imageSource = (part: Prompt.FilePart) =>
  Match.value(part.data).pipe(
    Match.when(Predicate.isString, (data) =>
      partOptions(part).url === true
        ? ({ type: "url", url: data } as const)
        : ({ type: "base64", base64: data } as const),
    ),
    Match.when(
      Predicate.isUint8Array,
      (bytes) => ({ type: "base64", base64: Buffer.from(bytes).toString("base64") }) as const,
    ),
    Match.orElse((url) => ({ type: "url", url: url.toString() }) as const),
  );

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

/** An assistant turn's blocks: Anthropic thinking first, then the text, then the calls. */
const anthropicAssistant = (message: Prompt.AssistantMessage): ReadonlyArray<AnthropicBlock> => [
  ...message.content.flatMap((part) =>
    part.type === "reasoning"
      ? Option.fromUndefinedOr(partOptions(part).signature).pipe(
          Option.filter((signature) => Option.isNone(decodeOpenAiReasoning(signature))),
          Option.map((signature): AnthropicBlock => ({
            type: "thinking",
            thinking: part.text,
            signature,
          })),
          Option.toArray,
        )
      : [],
  ),
  ...message.content.flatMap((part): ReadonlyArray<AnthropicBlock> =>
    part.type === "text" ? [{ type: "text", text: part.text }] : [],
  ),
  ...message.content.flatMap((part): ReadonlyArray<AnthropicBlock> =>
    part.type === "tool-call" && !part.providerExecuted
      ? [{ type: "tool_use", id: part.id, name: part.name, input: toolInput(callArguments(part)) }]
      : [],
  ),
];

const anthropicMessages = (prompt: Prompt.Prompt) =>
  Arr.reduce(
    prompt.content,
    Arr.empty<AnthropicMessage>(),
    (output: ReadonlyArray<AnthropicMessage>, message) =>
      Match.value(message).pipe(
        Match.discriminatorsExhaustive("role")({
          system: () => output,
          tool: (tool) =>
            appendAnthropicMessage(
              output,
              "user",
              tool.content.flatMap((part): ReadonlyArray<AnthropicBlock> =>
                part.type === "tool-result"
                  ? [
                      {
                        type: "tool_result",
                        tool_use_id: part.id,
                        content: textOf(toolResultContent(part)),
                        is_error: part.isFailure,
                      },
                    ]
                  : [],
              ),
            ),
          user: (user) =>
            appendAnthropicMessage(
              output,
              "user",
              user.content.map((part) =>
                Match.value(part).pipe(
                  Match.discriminatorsExhaustive("type")({
                    text: (text): AnthropicBlock => ({ type: "text", text: text.text }),
                    file: anthropicImage,
                  }),
                ),
              ),
            ),
          assistant: (assistant) =>
            appendAnthropicMessage(output, "assistant", anthropicAssistant(assistant)),
        }),
      ),
  );

/** Whether the conversation ends on an assistant turn, which Anthropic reads as a prefill. */
const endsOnAssistant = (messages: ReadonlyArray<{ readonly role: string }>) =>
  Option.exists(
    Arr.findLast(messages, (message) => message.role !== "system"),
    (last) => last.role === "assistant",
  );

/**
 * Anthropic refuses a request that ends on an assistant message: its models take no prefill. The
 * app never means one, so such a conversation gets a user turn, as jcode repairs it.
 */
const endingOnUser = (messages: ReadonlyArray<AnthropicMessage>) =>
  endsOnAssistant(messages)
    ? appendAnthropicMessage(messages, "user", [{ type: "text", text: "Continue." }])
    : messages;

/**
 * A user or assistant turn as Responses items: the encrypted reasoning it carries, a message of
 * its text and images, then its calls.
 */
const openAiTurn = (
  role: "user" | "assistant",
  parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>,
): ReadonlyArray<OpenAiItem> => {
  const textType = role === "assistant" ? "output_text" : "input_text";
  const content = parts.flatMap((part): ReadonlyArray<OpenAiBlock> =>
    Match.value(part).pipe(
      Match.when({ type: "text" }, (text): ReadonlyArray<OpenAiBlock> => [
        { type: textType, text: text.text },
      ]),
      Match.when({ type: "file" }, (file) => [openAiImage(file)]),
      Match.orElse(() => []),
    ),
  );
  return [
    ...parts.flatMap((part) =>
      part.type === "reasoning"
        ? Option.fromUndefinedOr(partOptions(part).signature).pipe(
            Option.flatMap(decodeOpenAiReasoning),
            Option.map((reasoning): OpenAiItem => ({
              type: "reasoning",
              id: reasoning.id,
              summary: [],
              encrypted_content: reasoning.encryptedContent,
            })),
            Option.toArray,
          )
        : [],
    ),
    ...(content.length > 0 ? [{ type: "message", role, content } as const] : []),
    ...parts.flatMap((part): ReadonlyArray<OpenAiItem> =>
      part.type === "tool-call" && !part.providerExecuted
        ? [
            {
              type: "function_call",
              call_id: part.id,
              name: part.name,
              arguments: callArguments(part),
            },
          ]
        : [],
    ),
  ];
};

const openAiInput = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    Match.value(message).pipe(
      Match.discriminatorsExhaustive("role")({
        system: (): ReadonlyArray<OpenAiItem> => [],
        tool: (tool) =>
          tool.content.flatMap((part): ReadonlyArray<OpenAiItem> =>
            part.type === "tool-result"
              ? [
                  {
                    type: "function_call_output",
                    call_id: part.id,
                    output: textOf(toolResultContent(part)),
                  },
                ]
              : [],
          ),
        user: (user) => openAiTurn("user", user.content),
        assistant: (assistant) => openAiTurn("assistant", assistant.content),
      }),
    ),
  );

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

const anthropicBody = (request: SubscriptionRequest) => {
  const { selection, prompt } = request;
  const system = systemText(prompt);
  const tools = canonicalTools(request.tools);
  const cacheControl = anthropicCacheControlFor(request.promptCache?.retention);
  const messages = endingOnUser(anthropicMessages(prompt));
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
    thinking: anthropicThinking(selection.model),
    output_config:
      selection.reasoningEffort === "none" ? undefined : { effort: selection.reasoningEffort },
  });
};

// The ChatGPT Responses subscription endpoint takes `prompt_cache_key` for cache routing (jcode
// sends its session id there). It has no confirmed contract for the retention fields, so a
// `'long'` retention still sends only the key and relies on the provider's automatic cache.
const openAiBody = (request: SubscriptionRequest) => {
  const { selection, prompt } = request;
  const tools = canonicalTools(request.tools);
  return JSON.stringify({
    model: selection.model,
    instructions: systemText(prompt),
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

/** The request body, which the client sends as it is. */
export const subscriptionBody = (request: SubscriptionRequest) =>
  Match.value(request.provider).pipe(
    Match.when("anthropic", () => anthropicBody(request)),
    Match.when("openai", () => openAiBody(request)),
    Match.exhaustive,
  );

/** The text the request log hashes: the history, and the tools in their sent order. */
const fingerprintSources = (prompt: Prompt.Prompt, tools: ReadonlyArray<Tool.Any>) => ({
  messages: JSON.stringify({ system: systemText(prompt), messages: openAiInput(prompt) }),
  tools: JSON.stringify(canonicalTools(tools)),
});

/** Hashes of the history and of the tools, which the request log carries instead of their text. */
const requestFingerprints = (request: LanguageModel.ProviderOptions) => {
  const sources = fingerprintSources(request.prompt, request.tools);
  return {
    messageFingerprint: sha256(sources.messages),
    toolFingerprint: sha256(sources.tools),
  };
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

/** The token counts the stream reported; a later report replaces each count it carries. */
interface Tokens {
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
  readonly cachedPromptTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
}

interface StreamingCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

interface StreamingReasoning {
  readonly id: string;
  readonly signature: Option.Option<string>;
}

/**
 * What the stream has sent so far. OpenAI sends its encrypted reasoning right after the summary it
 * belongs to, so a summary's end waits for the next event: encrypted reasoning puts its signature
 * on that end, as TanStack put it on the current thinking step. Encrypted reasoning after anything
 * else is a block without text.
 */
interface Translation {
  readonly textId: Option.Option<string>;
  readonly texts: number;
  readonly toolCalls: number;
  readonly tokens: Tokens;
  /** The calls and reasoning blocks still streaming, by their block index. */
  readonly streamingCalls: HashMap.HashMap<number, StreamingCall>;
  readonly streamingReasoning: HashMap.HashMap<number, StreamingReasoning>;
  readonly summaryCharacters: number;
  readonly summaryCount: number;
  readonly openSummaries: number;
  readonly summaries: HashMap.HashMap<string, SummaryState>;
  /** The summary whose end waits for its encrypted reasoning. */
  readonly endingSummary: Option.Option<string>;
}

const initialTranslation: Translation = {
  textId: Option.none(),
  texts: 0,
  toolCalls: 0,
  tokens: {
    promptTokens: undefined,
    completionTokens: undefined,
    cachedPromptTokens: undefined,
    cacheWriteTokens: undefined,
  },
  streamingCalls: HashMap.empty(),
  streamingReasoning: HashMap.empty(),
  summaryCharacters: 0,
  summaryCount: 0,
  openSummaries: 0,
  summaries: HashMap.empty(),
  endingSummary: Option.none(),
};

/** The state after a step, and the parts it sends. */
type Translated = readonly [Translation, ReadonlyArray<Part>];
type Translating = Effect.Effect<Translated, SubscriptionFailure>;

const emit = (state: Translation, parts: ReadonlyArray<Part> = []): Translating =>
  Effect.succeed<Translated>([state, parts]);

/** Runs `next` on the state `done` left; its parts go out after `done`'s. */
const andThen = ([state, parts]: Translated, next: (state: Translation) => Translating) =>
  Effect.map(next(state), ([after, added]): Translated => [after, [...parts, ...added]]);

const closeText = (state: Translation): Translated =>
  Option.match(state.textId, {
    onNone: () => [state, []],
    onSome: (id) => [{ ...state, textId: Option.none() }, [{ type: "text-end", id }]],
  });

const endSummary = (state: Translation, signature: Option.Option<string>): Translated =>
  Option.match(state.endingSummary, {
    onNone: () => [state, []],
    onSome: (id) => [
      { ...state, endingSummary: Option.none() },
      [
        {
          type: "reasoning-end",
          id,
          ...metadata(optionalProperty("signature", Option.getOrUndefined(signature))),
        },
      ],
    ],
  });

const summaryIdOf = (event: { readonly id: string; readonly summaryIndex: number }) =>
  `reasoning-summary-${event.id}-${event.summaryIndex}`;

const summaryFailed = (reason: ReasoningSummaryProtocolFailed["reason"]) =>
  ReasoningSummaryProtocolFailed.make({ reason });

/** The summary `summaryId` names, which must still be receiving text. */
const openSummary = (state: Translation, summaryId: string) =>
  Effect.fromOption(HashMap.get(state.summaries, summaryId), () =>
    summaryFailed(ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({})),
  ).pipe(
    Effect.filterOrFail(SummaryState.$is("open"), () =>
      summaryFailed(ReasoningSummaryProtocolFailedReason.cases.AlreadyEnded.make({})),
    ),
  );

/** Turns provider events into response parts, one event at a time, and checks the block protocol. */
const makeTranslator = (provider: OAuthProvider) => {
  const failed = (reason: SubscriptionStreamFailed["reason"]) =>
    SubscriptionStreamFailed.make({ provider, reason });
  const withinSummaryLimit = (state: Translation, added: number) =>
    state.summaryCharacters + added <= publicReasoningLimits.characters;
  const summaryLimit = () =>
    summaryFailed(ReasoningSummaryProtocolFailedReason.cases.ResourceLimit.make({}));
  const isFree = (state: Translation, index: number) =>
    !HashMap.has(state.streamingCalls, index) && !HashMap.has(state.streamingReasoning, index);

  /** A block end while no text is open: it ends the reasoning or the call at its index. */
  const blockEnd = (state: Translation, index: number): Translating =>
    Option.match(HashMap.get(state.streamingReasoning, index), {
      onSome: (reasoning) =>
        emit({ ...state, streamingReasoning: HashMap.remove(state.streamingReasoning, index) }, [
          {
            type: "reasoning-end",
            id: reasoning.id,
            ...metadata(optionalProperty("signature", Option.getOrUndefined(reasoning.signature))),
          },
        ]),
      onNone: () =>
        Effect.fromOption(HashMap.get(state.streamingCalls, index), () =>
          failed(SubscriptionStreamFailedReason.cases.InvalidBlockEnd.make({})),
        ).pipe(
          Effect.map((call): Translated => [
            { ...state, streamingCalls: HashMap.remove(state.streamingCalls, index) },
            [
              { type: "tool-params-end", id: call.id },
              {
                type: "tool-call",
                id: call.id,
                name: call.name,
                params: paramsOf(call.arguments),
                ...metadata({ arguments: call.arguments }),
              },
            ],
          ]),
        ),
    });

  /** The reasoning block at `index`, which must have started. */
  const streamingReasoningAt = (state: Translation, index: number) =>
    Effect.fromOption(HashMap.get(state.streamingReasoning, index), () =>
      failed(SubscriptionStreamFailedReason.cases.InvalidReasoning.make({})),
    );

  const translate = (state: Translation, event: NormalizedStreamEvent): Translating =>
    NormalizedStreamEvent.$match(event, {
      usage: (usage) =>
        emit({
          ...state,
          tokens: {
            promptTokens: usage.promptTokens ?? state.tokens.promptTokens,
            completionTokens: usage.completionTokens ?? state.tokens.completionTokens,
            cachedPromptTokens: usage.cachedPromptTokens ?? state.tokens.cachedPromptTokens,
            cacheWriteTokens: usage.cacheWriteTokens ?? state.tokens.cacheWriteTokens,
          },
        }),
      error: ({ code, message }) =>
        Effect.fail(
          failed(
            SubscriptionStreamFailedReason.cases.ProviderRejected.make({
              error: boundedErrorDetail({ type: code, message }),
            }),
          ),
        ),
      // Public OpenAI summary parts are reasoning blocks of their own, not Anthropic block ends.
      "reasoning-summary-start": (start) => {
        const summaryId = summaryIdOf(start);
        if (HashMap.has(state.summaries, summaryId)) {
          return Effect.fail(
            summaryFailed(ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({})),
          );
        }
        if (
          state.summaryCount >= publicReasoningLimits.parts ||
          start.id.length > publicReasoningLimits.idCharacters ||
          !withinSummaryLimit(state, start.text.length)
        ) {
          return Effect.fail(summaryLimit());
        }
        return emit(
          {
            ...state,
            summaryCount: state.summaryCount + 1,
            openSummaries: state.openSummaries + 1,
            summaryCharacters: state.summaryCharacters + start.text.length,
            summaries: HashMap.set(
              state.summaries,
              summaryId,
              SummaryState.open({ text: start.text }),
            ),
          },
          [
            { type: "reasoning-start", id: summaryId },
            ...(start.text.length > 0
              ? [{ type: "reasoning-delta" as const, id: summaryId, delta: start.text }]
              : []),
          ],
        );
      },
      "reasoning-summary-delta": (delta) => {
        const summaryId = summaryIdOf(delta);
        return openSummary(state, summaryId).pipe(
          Effect.filterOrFail(() => withinSummaryLimit(state, delta.delta.length), summaryLimit),
          Effect.map((summary): Translated => [
            {
              ...state,
              summaryCharacters: state.summaryCharacters + delta.delta.length,
              summaries: HashMap.set(
                state.summaries,
                summaryId,
                SummaryState.open({ text: summary.text + delta.delta }),
              ),
            },
            [{ type: "reasoning-delta", id: summaryId, delta: delta.delta }],
          ]),
        );
      },
      "reasoning-summary-end": (end) => {
        const summaryId = summaryIdOf(end);
        return openSummary(state, summaryId).pipe(
          Effect.filterOrFail(
            (summary) => end.text.startsWith(summary.text),
            () =>
              summaryFailed(ReasoningSummaryProtocolFailedReason.cases.ConflictingSummary.make({})),
          ),
          Effect.map((summary) => end.text.slice(summary.text.length)),
          Effect.filterOrFail(
            (remaining) => withinSummaryLimit(state, remaining.length),
            summaryLimit,
          ),
          Effect.map((remaining): Translated => [
            {
              ...state,
              summaryCharacters: state.summaryCharacters + remaining.length,
              openSummaries: state.openSummaries - 1,
              summaries: HashMap.set(state.summaries, summaryId, SummaryState.closed()),
              endingSummary: Option.some(summaryId),
            },
            remaining.length > 0
              ? [{ type: "reasoning-delta", id: summaryId, delta: remaining }]
              : [],
          ]),
        );
      },
      reasoning: (reasoning) => {
        if (reasoning.encryptedContent.length > maxEncryptedReasoningCharacters) {
          return Effect.fail(
            failed(SubscriptionStreamFailedReason.cases.EncryptedReasoningLimit.make({})),
          );
        }
        const signature = encodeOpenAiReasoning(reasoning.id, reasoning.encryptedContent);
        const id = `reasoning-encrypted-${reasoning.id}`;
        return Effect.succeed(
          Option.match(state.endingSummary, {
            onSome: () => endSummary(state, Option.some(signature)),
            onNone: (): Translated => [
              state,
              [
                { type: "reasoning-start", id },
                { type: "reasoning-end", id, ...metadata({ signature }) },
              ],
            ],
          }),
        );
      },
      text: (text) =>
        Option.match(state.textId, {
          onSome: (id) => emit(state, [{ type: "text-delta", id, delta: text.text }]),
          onNone: () => {
            const id = `text-${state.texts}`;
            return emit({ ...state, textId: Option.some(id), texts: state.texts + 1 }, [
              { type: "text-start", id },
              { type: "text-delta", id, delta: text.text },
            ]);
          },
        }),
      // A block end closes the open text; with none open it ends the block at its index.
      "content-block-end": (end) =>
        Option.match(state.textId, {
          onSome: () => emit(...closeText(state)),
          onNone: () => blockEnd(state, end.index),
        }),
      "tool-call": (call) =>
        andThen(closeText(state), (closed) =>
          Effect.map(encodeToolArguments(call.arguments), (serialized): Translated => [
            { ...closed, toolCalls: closed.toolCalls + 1 },
            [
              { type: "tool-params-start", id: call.id, name: call.name },
              { type: "tool-params-delta", id: call.id, delta: serialized },
              { type: "tool-params-end", id: call.id },
              {
                type: "tool-call",
                id: call.id,
                name: call.name,
                params: call.arguments,
                ...metadata({ arguments: serialized }),
              },
            ],
          ]),
        ),
      "tool-call-start": (start) =>
        andThen(closeText(state), (closed) => {
          if (!isFree(closed, start.index)) {
            return Effect.fail(
              failed(SubscriptionStreamFailedReason.cases.InvalidToolCall.make({})),
            );
          }
          return emit(
            {
              ...closed,
              streamingCalls: HashMap.set(closed.streamingCalls, start.index, {
                id: start.id,
                name: start.name,
                arguments: "",
              }),
              toolCalls: closed.toolCalls + 1,
            },
            [{ type: "tool-params-start", id: start.id, name: start.name }],
          );
        }),
      "reasoning-start": (start) =>
        andThen(closeText(state), (closed) => {
          if (!isFree(closed, start.index)) {
            return Effect.fail(
              failed(SubscriptionStreamFailedReason.cases.InvalidReasoning.make({})),
            );
          }
          const id = `reasoning-${start.index}`;
          return emit(
            {
              ...closed,
              streamingReasoning: HashMap.set(closed.streamingReasoning, start.index, {
                id,
                signature: Option.none(),
              }),
            },
            [{ type: "reasoning-start", id }],
          );
        }),
      "reasoning-delta": (delta) =>
        andThen(closeText(state), (closed) =>
          Effect.map(streamingReasoningAt(closed, delta.index), (reasoning): Translated => [
            closed,
            [{ type: "reasoning-delta", id: reasoning.id, delta: delta.delta }],
          ]),
        ),
      "reasoning-signature": (signed) =>
        andThen(closeText(state), (closed) =>
          Effect.map(streamingReasoningAt(closed, signed.index), (reasoning): Translated => [
            {
              ...closed,
              streamingReasoning: HashMap.set(closed.streamingReasoning, signed.index, {
                ...reasoning,
                signature: Option.some(signed.signature),
              }),
            },
            [],
          ]),
        ),
      "tool-call-arguments": (delta) =>
        andThen(closeText(state), (closed) =>
          Effect.fromOption(HashMap.get(closed.streamingCalls, delta.index), () =>
            failed(SubscriptionStreamFailedReason.cases.InvalidToolCall.make({})),
          ).pipe(
            Effect.map((call): Translated => [
              {
                ...closed,
                streamingCalls: HashMap.set(closed.streamingCalls, delta.index, {
                  ...call,
                  arguments: call.arguments + delta.delta,
                }),
              },
              [{ type: "tool-params-delta", id: call.id, delta: delta.delta }],
            ]),
          ),
        ),
    });

  /** One event's parts; a summary waiting for its encrypted reasoning ends first otherwise. */
  const step = (state: Translation, event: NormalizedStreamEvent): Translating =>
    andThen(
      NormalizedStreamEvent.$is("usage")(event) || NormalizedStreamEvent.$is("reasoning")(event)
        ? [state, []]
        : endSummary(state, Option.none()),
      (ready) => translate(ready, event),
    );

  /** The end of the stream: every block must have ended, and the turn finishes. */
  const finish = (state: Translation): Translating => {
    if (state.openSummaries !== 0) {
      return Effect.fail(
        summaryFailed(ReasoningSummaryProtocolFailedReason.cases.IncompleteSummary.make({})),
      );
    }
    if (!HashMap.isEmpty(state.streamingCalls) || !HashMap.isEmpty(state.streamingReasoning)) {
      return Effect.fail(failed(SubscriptionStreamFailedReason.cases.IncompleteBlocks.make({})));
    }
    return andThen(endSummary(state, Option.none()), (summaryEnded) => {
      const [done, textEnded] = closeText(summaryEnded);
      const { tokens } = done;
      const uncached = Option.getOrUndefined(
        Option.map(
          Option.fromUndefinedOr(tokens.promptTokens),
          (total) => total - (tokens.cachedPromptTokens ?? 0) - (tokens.cacheWriteTokens ?? 0),
        ),
      );
      return emit(done, [
        ...textEnded,
        {
          type: "finish",
          reason: done.toolCalls > 0 ? "tool-calls" : "stop",
          usage: {
            inputTokens: {
              ...optionalProperty("total", tokens.promptTokens),
              ...optionalProperty("uncached", uncached),
              ...optionalProperty("cacheRead", tokens.cachedPromptTokens),
              ...optionalProperty("cacheWrite", tokens.cacheWriteTokens),
            },
            outputTokens: optionalProperty("total", tokens.completionTokens),
          },
        },
      ]);
    });
  };

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
  Predicate.isTagged(error.reason, "UnknownError")
    ? decodeFailure(error.reason.metadata[optionsKey])
    : Option.none();

/** A subscription model's failure as the user sees it, as the TanStack adapter worded it. */
export const shownSubscriptionFailure = (error: AiError.AiError): ShownFailure =>
  Option.match(subscriptionFailure(error), {
    onNone: () => shownReason(error),
    onSome: (failure) => ({ message: failure.message }),
  });

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

export const subscriptionModel = Effect.fnUntraced(function* (options: SubscriptionModelOptions) {
  const { client, selection } = options;
  const provider = selection.provider;
  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.when(
          Effect.fail(unsupported("Subscription models do not support structured output.")),
          Effect.succeed(request.responseFormat.type === "json"),
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
        const fingerprints = requestFingerprints(replayed);
        yield* Effect.logDebug("subscription model request").pipe(
          Effect.annotateLogs({
            provider,
            model: selection.model,
            messages: replayed.prompt.content.length,
            tools: request.tools.length,
            ...fingerprints,
          }),
        );
        // `endingOnUser` repaired the request; the run that sent it should have ended on a user turn.
        yield* Effect.when(
          Effect.logWarning("subscription request ended on an assistant message").pipe(
            Effect.annotateLogs({ provider, model: selection.model }),
          ),
          Effect.succeed(provider === "anthropic" && endsOnAssistant(replayed.prompt.content)),
        );
        const translator = makeTranslator(provider);
        return providerEventsWithPromptCacheFallback({
          client,
          provider,
          body,
          baselineBody,
          onFallback: Effect.logDebug(
            "subscription prompt cache rejected; retrying baseline request",
          ).pipe(Effect.annotateLogs({ provider })),
        }).pipe(
          Stream.tap((event) =>
            Effect.logTrace("subscription stream event").pipe(
              Effect.annotateLogs({ provider, eventType: streamEventType(event) }),
            ),
          ),
          // None marks the end of the stream, where the turn finishes.
          Stream.map(Option.some),
          Stream.concat(Stream.succeed(Option.none<NormalizedStreamEvent>())),
          Stream.mapAccumEffect(
            () => initialTranslation,
            (state, event): Translating =>
              Option.match(event, {
                onSome: (received) => translator.step(state, received),
                onNone: () => translator.finish(state),
              }),
          ),
          Stream.catch((failure: SubscriptionFailure) =>
            Stream.fromEffect(
              Effect.logError("subscription model request failed").pipe(
                // `detail` is the message the user sees, the provider's own words included.
                Effect.annotateLogs({
                  provider,
                  code: streamFailureCode(failure),
                  detail: failure.message,
                }),
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
