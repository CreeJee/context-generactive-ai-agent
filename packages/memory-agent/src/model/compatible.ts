import { OpenAiClient } from "@effect/ai-openai-compat";
import {
  Array as Arr,
  Context,
  Effect,
  type JsonSchema,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
  String as Str,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";
import type { ShownFailure } from "../providers/contracts.ts";
import {
  reservedOutput,
  type OpenAICompatibleConfiguration,
} from "../providers/openai-compatible-config.ts";
import { isTruthy } from "../truthy.ts";
import { providerPrompt, type ReplayTarget } from "./history.ts";
import { optionsKey, partOptions, toolResultContent, type StoredContent } from "./prompt.ts";
import { collectResponse } from "./response.ts";
import { shownReason } from "./shown-failure.ts";
import { toolParameters } from "./tool-schema.ts";

/**
 * An OpenAI-compatible Chat Completions endpoint as an Effect `LanguageModel`. The request body is
 * the one TanStack's `openaiCompatibleText` built for the same history, after this app's fetch
 * changes (`providers/openai-compatible.ts`), and the stream becomes the parts TanStack's
 * `processStreamChunks` read from it. `OpenAiClient` sends the request and splits the events.
 */

/**
 * Why this app refused or failed a compatible request, carried in the `AiError`
 * (`compatibleFailure`). The message is fixed text without URLs, headers or payloads.
 */
export const CompatibleRunRequestFailedReason = Schema.TaggedUnion({
  /** The run was released before the request went out. */
  Cancelled: {},
  KeychainUnavailable: {},
  ContextLimitExceeded: {},
  ToolCallingDisabled: {},
  /** fetch failed; `codes` are the Node/undici transport codes along its cause chain. */
  Transport: { codes: Schema.Array(Schema.String) },
});
export class CompatibleRunRequestFailed extends Schema.TaggedError<
  CompatibleRunRequestFailed,
  { readonly brand: unique symbol }
>()("CompatibleRunRequestFailed", {
  reason: CompatibleRunRequestFailedReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return CompatibleRunRequestFailedReason.match(this.reason, {
      Cancelled: () => "Compatible run cancelled",
      KeychainUnavailable: () => "Compatible keychain unavailable",
      ContextLimitExceeded: () => "Compatible context limit exceeded",
      ToolCallingDisabled: () => "Compatible tool calling is disabled",
      Transport: (reason) =>
        `Compatible API request failed: ${
          reason.codes.length > 0 ? reason.codes.join(" <- ") : "transport failure"
        }`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

/** TanStack's `hashToolCallId`: two 32-bit lanes in base 36, for ids that must be short. */
const hashToolCallId = (id: string) => {
  const seed: readonly [number, number] = [3735928559, 1103547991];
  // Each UTF-16 code unit, as `charCodeAt` reads them.
  const [lane1, lane2] = Arr.reduce(
    Arr.makeBy(id.length, (index) => id.charCodeAt(index)),
    seed,
    ([h1, h2], character) =>
      [Math.imul(h1 ^ character, 2654435761), Math.imul(h2 ^ character, 1597334677)] as const,
  );
  const h1 =
    Math.imul(lane1 ^ (lane1 >>> 16), 2246822507) ^ Math.imul(lane2 ^ (lane2 >>> 13), 3266489909);
  const h2 =
    Math.imul(lane2 ^ (lane2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
};

const idSafe = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");

/** A first id: the call and item ids of `call|item`, joined while they stay short. */
const joinedToolCallId = (id: string) =>
  Option.match(
    Option.liftPredicate(id.indexOf("|"), (separator) => separator !== -1),
    {
      onNone: () => id,
      onSome: (separator) => {
        const call = idSafe(id.slice(0, separator));
        const item = idSafe(id.slice(separator + 1));
        const combined = item === "" ? call : `${call}_${item}`;
        return combined.length <= 40
          ? combined
          : `${call.slice(0, 31)}_${hashToolCallId(id).slice(0, 8)}`;
      },
    },
  );

/** The id another model's call gets, as TanStack's Chat Completions adapter renamed it. */
const compatibleToolCallId = (id: string, attempt: number) =>
  attempt > 0
    ? `${idSafe(id.split("|")[0] ?? "").slice(0, 31) || "call"}_${hashToolCallId(
        `${id}:${attempt}`,
      ).slice(0, 8)}`
    : joinedToolCallId(id);

/** The model a compatible request goes to; turns any other model wrote are replayed as foreign. */
export const compatibleTarget = (model: string): ReplayTarget => ({
  source: { provider: "openai-compatible", api: "openai-completions", model },
  toolCallId: compatibleToolCallId,
});

// ---------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------

type ChatMessage = OpenAiClient.ChatCompletionRequestMessage;
type ChatContentPart = OpenAiClient.ChatCompletionContentPart;
type ChatTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string | undefined;
    readonly parameters: JsonSchema.JsonSchema;
    readonly strict: false;
  };
};

/**
 * The request as `OpenAiClient` sends it. The stream fields are already in their place, so the
 * client's own copies keep TanStack's key order.
 */
export type CompatiblePayload = {
  readonly max_tokens?: number;
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ChatTool>;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly reasoning_effort?: string;
};

const invalidRequest = (description: string) =>
  AiError.make({
    module: "CompatibleLanguageModel",
    method: "streamText",
    reason: AiError.InvalidRequestError.make({ description }),
  });

type ImageSource = Extract<
  Exclude<StoredContent, string>[number],
  { readonly type: "image" }
>["source"];

/** A stored image as an `image_url` part; base64 data becomes a data URL. */
const imageUrlPart = (source: ImageSource): ChatContentPart => ({
  type: "image_url",
  image_url: {
    url:
      source.type === "data" && !source.value.startsWith("data:")
        ? `data:${isTruthy(source.mimeType) ? source.mimeType : "application/octet-stream"};base64,${source.value}`
        : source.value,
    detail: "auto",
  },
});

/** The stored image `toPrompt` made a file part of. */
const imageSource = (part: Prompt.FilePart): ImageSource => {
  const options = partOptions(part);
  // `toPrompt` keeps image data as the stored string.
  const value = String(part.data);
  return options.url === true
    ? {
        type: "url",
        value,
        ...optionalProperty("mimeType", options.untyped === true ? undefined : part.mediaType),
      }
    : { type: "data", value, mimeType: part.mediaType };
};

/** Tool result content: text stays text, and parts go as their JSON unless one is an image. */
const toolContent = (content: StoredContent) =>
  Match.value(content).pipe(
    Match.when(Predicate.isString, (text) => text),
    Match.when(
      (parts: Exclude<StoredContent, string>) => !parts.some((part) => part.type === "image"),
      (parts) => JSON.stringify(parts),
    ),
    Match.orElse((parts) => {
      const text = parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
      return text === "" ? "(see attached image)" : text;
    }),
  );

/** The images of tool result content, which go to the model in a user message after it. */
const toolImages = (content: StoredContent): Array<ChatContentPart> =>
  Predicate.isString(content)
    ? []
    : content.flatMap((part) => (part.type === "image" ? [imageUrlPart(part.source)] : []));

/** The arguments as the model sent them; the encoded parameters for a call made elsewhere. */
const callArguments = (part: Prompt.ToolCallPart) =>
  partOptions(part).arguments ?? JSON.stringify(part.params);

const userMessage = (message: Prompt.UserMessage): Effect.Effect<ChatMessage, AiError.AiError> =>
  Option.match(
    Option.filter(
      Arr.head(message.content),
      (part): part is Prompt.TextPart => part.type === "text" && message.content.length === 1,
    ),
    {
      // A message of one text part goes as plain text.
      onSome: (only) =>
        Effect.succeed(only.text).pipe(
          Effect.filterOrFail(
            (text) => text !== "",
            () =>
              invalidRequest(
                "User message for openai-compatible has empty text content. Empty user messages would produce a paid request with no input; provide non-empty content or omit the message.",
              ),
          ),
          Effect.map((text): ChatMessage => ({ role: "user", content: text })),
        ),
      onNone: () =>
        Effect.succeed(message.content).pipe(
          Effect.filterOrFail(
            (parts) => parts.length > 0,
            () =>
              invalidRequest(
                "User message for openai-compatible has no content parts. Empty user messages would produce a paid request with no input; provide at least one text/image/audio part or omit the message.",
              ),
          ),
          Effect.map((parts): ChatMessage => ({
            role: "user",
            content: parts.map((part) =>
              Match.value(part).pipe(
                Match.discriminatorsExhaustive("type")({
                  text: (text): ChatContentPart => ({ type: "text", text: text.text }),
                  file: (file) => imageUrlPart(imageSource(file)),
                }),
              ),
            ),
          })),
        ),
    },
  );

const assistantMessage = (message: Prompt.AssistantMessage): ChatMessage => {
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  const toolCalls = message.content.flatMap((part) =>
    part.type === "tool-call" && !part.providerExecuted
      ? [
          {
            id: part.id,
            type: "function" as const,
            function: { name: part.name, arguments: callArguments(part) },
          },
        ]
      : [],
  );
  return {
    role: "assistant",
    content: toolCalls.length > 0 && text === "" ? null : text,
    ...optionalProperty("tool_calls", toolCalls.length > 0 ? toolCalls : undefined),
  };
};

/** The images still waiting after a message, and the messages it sends. */
type Sending = readonly [
  ReadonlyArray<ChatContentPart>,
  ReadonlyArray<Effect.Effect<ChatMessage, AiError.AiError>>,
];

/**
 * The Chat Completions messages for a prompt that is already the provider prompt: the system
 * prompts joined first, and each tool result's images in a user message after the results.
 */
const chatMessages = (prompt: Prompt.Prompt) => {
  const system = prompt.content.flatMap((message) =>
    message.role === "system" ? [message.content] : [],
  );
  /** The images waiting for a message that is not a tool result, as a user message. */
  const imagesMessage = (images: ReadonlyArray<ChatContentPart>) =>
    images.length > 0 ? [Effect.succeed<ChatMessage>({ role: "user", content: [...images] })] : [];
  const [waiting, sent] = Arr.mapAccum(
    prompt.content,
    Arr.empty<ChatContentPart>(),
    (images: ReadonlyArray<ChatContentPart>, message): Sending =>
      Match.value(message).pipe(
        Match.discriminatorsExhaustive("role")({
          system: (): Sending => [images, []],
          user: (user): Sending => [[], [...imagesMessage(images), userMessage(user)]],
          assistant: (assistant): Sending => [
            [],
            [...imagesMessage(images), Effect.succeed(assistantMessage(assistant))],
          ],
          tool: (tool): Sending => {
            const results = tool.content
              .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
              .map((part) => [part.id, toolResultContent(part)] as const);
            return [
              [...images, ...results.flatMap(([, content]) => toolImages(content))],
              results.map(([id, content]) =>
                Effect.succeed<ChatMessage>({
                  role: "tool",
                  tool_call_id: id,
                  content: toolContent(content),
                }),
              ),
            ];
          },
        }),
      ),
  );
  return Effect.all([
    ...(system.length > 0
      ? [Effect.succeed<ChatMessage>({ role: "system", content: system.join("\n") })]
      : []),
    ...sent.flat(),
    ...imagesMessage(waiting),
  ]);
};

/**
 * Tools go with the schema they were written with and `strict: false`. Strict mode makes optional
 * fields required and nullable, and local models then guess values (decisions.md 2026-10-25).
 */
const chatTools = (tools: ReadonlyArray<Tool.Any>): Array<ChatTool> =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: Tool.getDescription(tool),
      parameters: toolParameters(tool),
      strict: false,
    },
  }));

/** What a compatible request is made of. */
export interface CompatibleRequest {
  readonly endpoint: OpenAICompatibleConfiguration;
  /** `default` sends none and leaves the server's own effort. */
  readonly reasoningEffort: string;
  /** The provider prompt (`providerPrompt` with `compatibleTarget`). */
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
}

/** The request body; the keys keep the order TanStack's request had. */
export const compatibleBody = Effect.fnUntraced(function* (request: CompatibleRequest) {
  const { endpoint } = request;
  const tools = endpoint.toolCalling ? chatTools(request.tools) : [];
  return {
    ...optionalProperty("max_tokens", endpoint.outputBudget ?? undefined),
    model: endpoint.model,
    messages: yield* chatMessages(request.prompt),
    ...optionalProperty("tools", tools.length > 0 ? tools : undefined),
    stream: true,
    stream_options: { include_usage: true },
    ...optionalProperty(
      "reasoning_effort",
      request.reasoningEffort === "default" ? undefined : request.reasoningEffort,
    ),
  } satisfies CompatiblePayload;
});

/**
 * The local context guard: a quarter token per ASCII character of the body, one per other
 * character. It also counts the tool schemas, as the request carries them.
 */
const exceedsContext = (payload: CompatiblePayload, endpoint: OpenAICompatibleConfiguration) => {
  const body = JSON.stringify(payload);
  // Characters are code points, as `for...of` reads them.
  const ascii = body.replace(/\P{ASCII}+/gu, "").length;
  const other = Array.from(body.replace(/\p{ASCII}+/gu, "")).length;
  return (
    Math.ceil(ascii * 0.25 + other) + reservedOutput(endpoint.outputBudget) > endpoint.contextWindow
  );
};

/**
 * The request's shape for a template's "No user query found in messages" error: counts, roles,
 * the model and what kind of user content it sent, never the content (decisions.md 2026-10-04).
 */
const requestDiagnostic = (payload: CompatiblePayload) => {
  const { messages } = payload;
  const count = (role: ChatMessage["role"]) =>
    messages.filter((message) => message.role === role).length;
  const userContent = messages.flatMap((message) =>
    message.role === "user"
      ? [
          Match.value(message.content).pipe(
            Match.when(Predicate.isString, (content) => {
              const text = content.trim();
              const wrapped =
                text.startsWith("<tool_response>") && text.endsWith("</tool_response>");
              return `text:${content.length}:${wrapped ? "tool-response" : "plain"}`;
            }),
            Match.when(Match.null, () => "empty"),
            Match.orElse((parts) => `parts:${parts.length}`),
          ),
        ]
      : [],
  );
  return [
    `Compatible request messages: total=${messages.length}, user=${count("user")}, assistant=${count("assistant")}, tool=${count("tool")}, first=${messages[0]?.role ?? "none"}, last=${messages.at(-1)?.role ?? "none"}`,
    `model=${payload.model}, toolDefinitions=${payload.tools?.length ?? 0}, userContent=[${userContent.join(",")}]`,
  ].join(", ");
};

// ---------------------------------------------------------------------------------------------
// Response stream
// ---------------------------------------------------------------------------------------------

type Part = Response.StreamPartEncoded;

/** A field the stream reads only when it is a string; anything else counts as absent. */
const Loose = Schema.optionalKey(JsonValue);

const ToolCallDelta = Schema.Struct({
  index: Loose,
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  function: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        arguments: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const Chunk = Schema.Struct({
  id: Loose,
  model: Loose,
  choices: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          delta: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                content: Schema.optionalKey(Schema.NullOr(Schema.String)),
                tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(ToolCallDelta))),
                reasoning_content: Loose,
                reasoning: Loose,
                reasoning_text: Loose,
              }),
            ),
          ),
          finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
  usage: Loose,
  error: Loose,
});
type Chunk = typeof Chunk.Type;
const decodeChunk = Schema.decodeUnknownOption(Chunk);

const Count = Schema.optionalKey(Schema.NullOr(Schema.Finite));
/** Usage as TanStack's `buildChatCompletionsUsage` read it; other shapes count as no usage. */
const Usage = Schema.Struct({
  prompt_tokens: Count,
  completion_tokens: Count,
  cached_tokens: Count,
  prompt_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ cached_tokens: Count, cache_write_tokens: Count })),
  ),
  completion_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ reasoning_tokens: Count })),
  ),
});
type Usage = typeof Usage.Type;
const decodeUsage = Schema.decodeUnknownOption(Usage);

/** The finish reasons the stream accepts, as Chat Completions names them. */
const FinishReason = Schema.Literals([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
]);
type FinishReason = typeof FinishReason.Type;
const isFinishReason = Schema.is(FinishReason);
const finishReasons = {
  stop: "stop",
  length: "length",
  content_filter: "content-filter",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
} as const satisfies { readonly [reason in FinishReason]: Response.FinishReason };

const invalidOutput = (description: string) =>
  AiError.make({
    module: "CompatibleLanguageModel",
    method: "streamText",
    reason: AiError.InvalidOutputError.make({ description }),
  });

/** An `error` event's message as the OpenAI SDK made it. */
const errorMessage = (error: JsonValue) =>
  Option.liftPredicate(error, Predicate.isObject).pipe(
    Option.map((object) => object["message"]),
    Option.filter((message) => isTruthy(message)),
    Option.match({
      onNone: () => JSON.stringify(error),
      onSome: (message) => (Predicate.isString(message) ? message : JSON.stringify(message)),
    }),
  );

/** An `error` event in the stream. */
const providerError = (error: JsonValue) =>
  AiError.make({
    module: "CompatibleLanguageModel",
    method: "streamText",
    reason: AiError.UnknownError.make({ description: errorMessage(error) }),
  });

const toolCallingDisabled = () =>
  CompatibleRunRequestFailed.make({
    reason: CompatibleRunRequestFailedReason.cases.ToolCallingDisabled.make({}),
  });

const decodeArguments = Schema.decodeOption(Schema.fromJsonString(JsonValue));
/** The parameters of the arguments: `{}` for none or a non-object, the text when they do not parse. */
const paramsOf = (serialized: string) =>
  serialized === ""
    ? {}
    : Option.match(decodeArguments(serialized), {
        onNone: () => serialized,
        onSome: (parsed) => (Predicate.isObject(parsed) ? parsed : {}),
      });

/** Stream part metadata this app reads: the arguments as the model sent them. */
const argumentsMetadata = (serialized: string) => ({
  metadata: { [optionsKey]: { arguments: serialized } },
});

const finishUsage = (usage: Option.Option<Usage>) =>
  Option.match(usage, {
    onNone: () => ({ inputTokens: {}, outputTokens: {} }),
    onSome: (counted) => {
      const total = counted.prompt_tokens ?? 0;
      const cacheRead =
        counted.prompt_tokens_details?.cached_tokens || counted.cached_tokens || undefined;
      const cacheWrite = counted.prompt_tokens_details?.cache_write_tokens || undefined;
      return {
        inputTokens: {
          total,
          uncached: total - (cacheRead ?? 0) - (cacheWrite ?? 0),
          ...optionalProperty("cacheRead", cacheRead),
          ...optionalProperty("cacheWrite", cacheWrite),
        },
        outputTokens: {
          total: counted.completion_tokens ?? 0,
          ...optionalProperty(
            "reasoning",
            counted.completion_tokens_details?.reasoning_tokens || undefined,
          ),
        },
      };
    },
  });

/** The slot a call's deltas go to, and the id and name the call has so far. */
interface CallSlot {
  readonly index: number;
  readonly id: string;
  readonly name: string;
}

/** A call the stream is sending. */
interface StreamingCall extends CallSlot {
  readonly arguments: string;
  /** Whether its start went out; that waits for its id and name. */
  readonly started: boolean;
}

/**
 * What the stream has sent so far, as TanStack's `processStreamChunks` kept it: one reasoning
 * block until the text starts, one text block until the finish reason, and calls that start once
 * their id and name are known and end at the finish reason. A call that never got both is dropped.
 */
interface Translation {
  readonly chunks: number;
  readonly textId: Option.Option<string>;
  readonly texts: number;
  readonly reasoningId: Option.Option<string>;
  readonly reasonings: number;
  readonly responseId: Option.Option<string>;
  readonly modelId: Option.Option<string>;
  readonly usage: Option.Option<Usage>;
  /** Whether the last chunk carried usage and no choice. */
  readonly endsWithUsage: boolean;
  readonly finishReason: Option.Option<string>;
  readonly endedCalls: number;
  /** The open calls, in the order their slots came. */
  readonly calls: ReadonlyArray<StreamingCall>;
  /** The call the last delta went to; it stays after the calls end. */
  readonly latest: Option.Option<CallSlot>;
}

const initialTranslation: Translation = {
  chunks: 0,
  textId: Option.none(),
  texts: 0,
  reasoningId: Option.none(),
  reasonings: 0,
  responseId: Option.none(),
  modelId: Option.none(),
  usage: Option.none(),
  endsWithUsage: false,
  finishReason: Option.none(),
  endedCalls: 0,
  calls: [],
  latest: Option.none(),
};

/** The state after a step, and the parts it sends. */
type Translated = readonly [Translation, ReadonlyArray<Part>];
type Translating = Result.Result<Translated, AiError.AiError | CompatibleRunRequestFailed>;
type Step = (state: Translation) => Translating;

const emit = (state: Translation, parts: ReadonlyArray<Part> = []): Translating =>
  Result.succeed<Translated>([state, parts]);

/** Runs `steps` in order, each on the state the one before left; their parts go out in order. */
const translateAll = (state: Translation, steps: ReadonlyArray<Step>) =>
  Arr.reduce(steps, emit(state), (done, step) =>
    Result.flatMap(done, ([current, parts]) =>
      Result.map(step(current), ([after, added]): Translated => [after, [...parts, ...added]]),
    ),
  );

/** A field's text, when it is a string that is not empty. */
const nonEmptyText = (value: JsonValue | undefined) =>
  Option.filter(Option.liftPredicate(value, Predicate.isString), (text) => text !== "");

const closeText: Step = (state) =>
  Option.match(state.textId, {
    onNone: () => emit(state),
    onSome: (id) => emit({ ...state, textId: Option.none() }, [{ type: "text-end", id }]),
  });

const closeReasoning: Step = (state) =>
  Option.match(state.reasoningId, {
    onNone: () => emit(state),
    onSome: (id) => emit({ ...state, reasoningId: Option.none() }, [{ type: "reasoning-end", id }]),
  });

const endCalls: Step = (state) => {
  const started = state.calls.filter((call) => call.started);
  return emit(
    { ...state, calls: [], endedCalls: state.endedCalls + started.length },
    started.flatMap((call): ReadonlyArray<Part> => [
      { type: "tool-params-end", id: call.id },
      {
        type: "tool-call",
        id: call.id,
        name: call.name,
        params: paramsOf(call.arguments),
        ...argumentsMetadata(call.arguments),
      },
    ]),
  );
};

const reasoningDelta =
  (delta: string): Step =>
  (state) =>
    Option.match(state.reasoningId, {
      onSome: (id) => emit(state, [{ type: "reasoning-delta", id, delta }]),
      onNone: () => {
        const id = `reasoning-${state.reasonings}`;
        return emit({ ...state, reasoningId: Option.some(id), reasonings: state.reasonings + 1 }, [
          { type: "reasoning-start", id },
          { type: "reasoning-delta", id, delta },
        ]);
      },
    });

const textDelta =
  (delta: string): Step =>
  (state) =>
    Option.match(state.textId, {
      onSome: (id) => emit(state, [{ type: "text-delta", id, delta }]),
      onNone: () => {
        const id = `text-${state.texts}`;
        return emit({ ...state, textId: Option.some(id), texts: state.texts + 1 }, [
          { type: "text-start", id },
          { type: "text-delta", id, delta },
        ]);
      },
    });

type CallDelta = (typeof ToolCallDelta)["Type"];

/** Whether a delta with `id` and `name` starts the call after `latest`, as TanStack told. */
const startsNext = (latest: CallSlot, id: string, name: string) =>
  (id !== "" && latest.id !== "" && id !== latest.id) ||
  (id !== "" && latest.id === "" && name !== "" && latest.name !== "" && name !== latest.name) ||
  (id === "" && name !== "" && latest.name !== "" && name !== latest.name);

/** The first slot from `index` that no open call takes. */
const freeIndex = (calls: ReadonlyArray<StreamingCall>, index: number): number =>
  calls.some((call) => call.index === index) ? freeIndex(calls, index + 1) : index;

/** The slot a call delta belongs to, as TanStack resolved deltas without an index. */
const callIndex = (state: Translation, delta: CallDelta) =>
  Option.liftPredicate(delta.index, Predicate.isNumber).pipe(
    Option.orElse(() =>
      Option.map(state.latest, (latest) =>
        startsNext(latest, delta.id ?? "", delta.function?.name ?? "")
          ? freeIndex(state.calls, latest.index + 1)
          : latest.index,
      ),
    ),
    Option.getOrElse(() => 0),
  );

const callDelta =
  (toolCalling: boolean, delta: CallDelta): Step =>
  (state) => {
    const index = callIndex(state, delta);
    const known = Arr.findFirst(state.calls, (call) => call.index === index);
    const prior = Option.getOrElse(known, (): StreamingCall => ({
      index,
      id: "",
      name: "",
      arguments: "",
      started: false,
    }));
    const added = delta.function?.arguments ?? "";
    const id = delta.id || prior.id;
    const name = delta.function?.name || prior.name;
    const starts = !prior.started && id !== "" && name !== "";
    const call: StreamingCall = {
      index,
      id,
      name,
      arguments: prior.arguments + added,
      started: prior.started || starts,
    };
    const parts: ReadonlyArray<Part> = [
      ...(starts ? [{ type: "tool-params-start", id, name } as const] : []),
      // Arguments that came before the id and name are sent with the start.
      ...(starts && prior.arguments !== ""
        ? [{ type: "tool-params-delta", id, delta: prior.arguments } as const]
        : []),
      ...(call.started && added !== ""
        ? [{ type: "tool-params-delta", id, delta: added } as const]
        : []),
    ];
    return starts && !toolCalling
      ? Result.fail(toolCallingDisabled())
      : emit(
          {
            ...state,
            calls: Option.match(known, {
              onNone: () => [...state.calls, call],
              onSome: () => state.calls.map((open) => (open.index === index ? call : open)),
            }),
            latest: Option.some(call),
          },
          parts,
        );
  };

/** A chunk's steps: its fields, reasoning, text, call deltas, and the finish reason's ends. */
const chunkSteps = (toolCalling: boolean, chunk: Chunk): ReadonlyArray<Step> => {
  const choices = chunk.choices ?? [];
  const delta = choices[0]?.delta ?? {};
  const counted: Step = (state) =>
    emit({
      ...state,
      chunks: state.chunks + 1,
      endsWithUsage: choices.length === 0 && chunk.usage !== undefined && chunk.usage !== null,
      usage: Option.orElse(decodeUsage(chunk.usage), () => state.usage),
      responseId: Option.orElse(nonEmptyText(chunk.id), () => state.responseId),
      modelId: Option.orElse(nonEmptyText(chunk.model), () => state.modelId),
    });
  const reasoning = Option.map(
    nonEmptyText(delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text),
    reasoningDelta,
  );
  return [
    counted,
    ...Option.toArray(reasoning),
    ...Option.match(Arr.head(choices), {
      onNone: (): ReadonlyArray<Step> => [],
      onSome: (choice): ReadonlyArray<Step> => [
        ...Option.match(nonEmptyText(delta.content), {
          onNone: (): ReadonlyArray<Step> => [],
          onSome: (content) => [closeReasoning, textDelta(content)],
        }),
        ...(delta.tool_calls ?? []).map((call) => callDelta(toolCalling, call)),
        ...Option.match(nonEmptyText(choice.finish_reason), {
          onNone: (): ReadonlyArray<Step> => [],
          onSome: (reason): ReadonlyArray<Step> => [
            endCalls,
            closeText,
            (state) => emit({ ...state, finishReason: Option.some(reason) }),
          ],
        }),
      ],
    }),
  ];
};

const translateChunk = (
  toolCalling: boolean,
  state: Translation,
  decoded: Option.Option<Chunk>,
): Translating =>
  Option.match(decoded, {
    onNone: () => Result.fail(invalidOutput("Invalid Chat Completions chunk")),
    onSome: (chunk) =>
      Option.match(
        Option.filter(Option.fromNullishOr(chunk.error), (error) => isTruthy(error)),
        {
          onSome: (error) => Result.fail(providerError(error)),
          onNone: () => translateAll(state, chunkSteps(toolCalling, chunk)),
        },
      ),
  });

/** One stream event's parts; `[DONE]` has none. */
const translateEvent = (
  toolCalling: boolean,
  state: Translation,
  event: OpenAiClient.ChatCompletionStreamEvent,
): Translating =>
  Match.value(event).pipe(
    Match.when("[DONE]", () => emit(state)),
    // Servers vary: whatever parsed is read for the fields TanStack read.
    Match.when({ _tag: "UnknownChatCompletionEvent" }, (unknown) =>
      translateChunk(toolCalling, state, decodeChunk(unknown.data)),
    ),
    Match.orElse((chunk) => translateChunk(toolCalling, state, decodeChunk(chunk))),
  );

/** The turn's reason as TanStack reported it: a call makes it `tool_calls`. */
const turnFinishReason = (state: Translation): FinishReason => {
  const reason = Option.filter(state.finishReason, isFinishReason);
  return Option.filter(reason, (known) => known === "length").pipe(
    Option.orElse(() =>
      Option.filter(Option.some<FinishReason>("tool_calls"), () => state.endedCalls > 0),
    ),
    Option.orElse(() => Option.filter(reason, (known) => known !== "tool_calls")),
    Option.getOrElse((): FinishReason => "stop"),
  );
};

/** The end of the stream: what is open closes and the turn finishes, unless the stream was cut. */
const finished: Step = (state) =>
  translateAll(state, [endCalls, closeText, closeReasoning]).pipe(
    Result.filterOrFail(
      ([done]) => done.chunks > 0 && (Option.isSome(done.finishReason) || done.endsWithUsage),
      () =>
        invalidOutput("Chat Completions stream ended without a finish_reason or usage-only tail"),
    ),
    Result.flatMap(([done, ended]) =>
      Option.match(
        Option.filter(done.finishReason, (reason) => !isFinishReason(reason)),
        {
          onSome: (reason) => Result.fail(invalidOutput(`Provider finish_reason: ${reason}`)),
          onNone: () =>
            emit(done, [
              ...ended,
              {
                type: "response-metadata",
                ...optionalProperty("id", Option.getOrUndefined(done.responseId)),
                ...optionalProperty("modelId", Option.getOrUndefined(done.modelId)),
              },
              {
                type: "finish",
                reason: finishReasons[turnFinishReason(done)],
                usage: finishUsage(done.usage),
              },
            ]),
        },
      ),
    ),
  );

// ---------------------------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------------------------

const decodeFailure = Schema.decodeUnknownOption(CompatibleRunRequestFailed);

/** Fails with the `AiError` that carries `failure`. */
const failWith = (failure: CompatibleRunRequestFailed) =>
  Schema.encodeEffect(CompatibleRunRequestFailed)(failure).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.fail(
        AiError.make({
          module: "CompatibleLanguageModel",
          method: "streamText",
          reason: AiError.UnknownError.make({
            description: failure.message,
            metadata: { [optionsKey]: encoded },
          }),
        }),
      ),
    ),
  );

/** The request the model sends, or the context guard's refusal before anything is sent. */
export const compatibleRequest = (request: CompatibleRequest) =>
  compatibleBody(request).pipe(
    Effect.filterOrElse(
      (payload) => !exceedsContext(payload, request.endpoint),
      () =>
        failWith(
          CompatibleRunRequestFailed.make({
            reason: CompatibleRunRequestFailedReason.cases.ContextLimitExceeded.make({}),
          }),
        ),
    ),
  );

/** The app failure an `AiError` from a compatible model carries. */
export const compatibleFailure = (
  error: AiError.AiError,
): Option.Option<CompatibleRunRequestFailed> =>
  Predicate.isTagged(error.reason, "UnknownError")
    ? decodeFailure(error.reason.metadata[optionsKey])
    : Option.none();

const templateError = "No user query found in messages";
const encodeReason = Schema.encodeUnknownOption(AiError.AiErrorReason);
const decodeReason = Schema.decodeUnknownOption(AiError.AiErrorReason);

/**
 * The error with `diagnostic` after its description when a chat template rejected the request;
 * the error keeps its reason (decisions.md 2026-10-04).
 */
const withDiagnostic = (error: AiError.AiError, diagnostic: string): AiError.AiError =>
  !error.message.includes(templateError)
    ? error
    : Option.getOrElse(
        encodeReason(error.reason).pipe(
          Option.flatMap((encoded) =>
            "description" in encoded && Predicate.isString(encoded.description)
              ? decodeReason({ ...encoded, description: `${encoded.description}\n${diagnostic}` })
              : Option.none(),
          ),
          Option.map((reason) =>
            AiError.make({ module: error.module, method: error.method, reason }),
          ),
        ),
        () => error,
      );

/**
 * A compatible model's failure as the user sees it. A chat template's refusal keeps its text and
 * the request's role counts after it (decisions.md 2026-10-04); the rest of the provider's
 * description, with the URL in it, is left out.
 */
export const shownCompatibleFailure = (error: AiError.AiError): ShownFailure =>
  Option.match(compatibleFailure(error), {
    onSome: (failure) => ({ message: failure.message }),
    onNone: () =>
      error.message.includes(templateError)
        ? { message: `${templateError}\n${Arr.lastNonEmpty(Str.split(error.message, "\n"))}` }
        : shownReason(error),
  });

/** A model whose every request fails with `failure`, for a run that cannot reach its endpoint. */
export const failingCompatibleModel = (failure: CompatibleRunRequestFailed) =>
  LanguageModel.make({
    streamText: () => Stream.fromEffect(failWith(failure)),
    generateText: () => failWith(failure),
  });

/** What the error log says about a failure: its reason, never provider text. */
const failureCode = (error: AiError.AiError) =>
  Option.match(compatibleFailure(error), {
    onNone: () => error.reason._tag,
    onSome: (failure) => failure.reason._tag,
  });

/** Node/undici transport codes (`ECONNRESET`, `ETIMEDOUT`, ...) surfaced from fetch failures. */
const isTransportErrorCode = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/)));

/** The transport codes along a failed fetch's cause chain; never URLs, headers or payloads. */
const transportCodes = (reason: HttpClientError.TransportError) =>
  // The errors along the chain, each once and at most eight.
  Arr.unfold({ current: reason.cause, seen: Arr.empty<Error>() }, ({ current, seen }) =>
    Option.liftPredicate(current, Predicate.isError).pipe(
      Option.filter((failure) => !seen.includes(failure) && seen.length < 8),
      Option.map(
        (failure) => [failure, { current: failure.cause, seen: [...seen, failure] }] as const,
      ),
    ),
  ).flatMap((failure) =>
    Predicate.hasProperty(failure, "code") && isTransportErrorCode(failure.code)
      ? [failure.code]
      : [],
  );

/** One run's compatible model: its endpoint, effort and key stay fixed for every step. */
export interface CompatibleModelOptions {
  readonly endpoint: OpenAICompatibleConfiguration;
  readonly reasoningEffort: string;
  /** Read by the caller for this endpoint; none sends no authorization. */
  readonly key: string | null;
  readonly fetcher: typeof globalThis.fetch;
}

export const compatibleModel = Effect.fnUntraced(function* (options: CompatibleModelOptions) {
  const { endpoint, reasoningEffort, fetcher } = options;
  // The fetch client has no resources; its scope only builds it.
  const http = yield* Effect.scoped(Layer.build(FetchHttpClient.layer)).pipe(
    Effect.map((services) => Context.get(services, HttpClient.HttpClient)),
  );
  const client = yield* OpenAiClient.make({
    apiUrl: endpoint.baseUrl,
    apiKey: isTruthy(options.key) ? Redacted.make(options.key) : undefined,
    transformClient: HttpClient.tapError((error) =>
      Match.value(error.reason).pipe(
        Match.tag("TransportError", (reason) =>
          // Do not log URLs, headers or payloads: the transport codes say what failed.
          Effect.logError(
            CompatibleRunRequestFailed.make({
              reason: CompatibleRunRequestFailedReason.cases.Transport.make({
                codes: transportCodes(reason),
              }),
            }).message,
          ),
        ),
        Match.orElse(() => Effect.void),
      ),
    ),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.when(
          Effect.fail(invalidRequest("Compatible models do not support structured output.")),
          Effect.succeed(request.responseFormat.type === "json"),
        );
        const payload = yield* compatibleRequest({
          endpoint,
          reasoningEffort,
          prompt: providerPrompt(request.prompt, compatibleTarget(endpoint.model)),
          tools: request.tools,
        });
        const diagnostic = requestDiagnostic(payload);
        yield* Effect.logDebug("compatible model request").pipe(
          Effect.annotateLogs({
            model: endpoint.model,
            messages: payload.messages.length,
            tools: payload.tools?.length ?? 0,
          }),
        );
        const [, events] = yield* client
          .createResponseStream(payload)
          .pipe(Effect.mapError((error) => withDiagnostic(error, diagnostic)));
        return events.pipe(
          // None marks the end of the stream, where the turn finishes.
          Stream.map(Option.some),
          Stream.concat(Stream.succeed(Option.none<OpenAiClient.ChatCompletionStreamEvent>())),
          Stream.mapAccumEffect(
            () => initialTranslation,
            (
              state,
              event,
            ): Effect.Effect<Translated, AiError.AiError | CompatibleRunRequestFailed> =>
              Option.match(event, {
                onSome: (received) =>
                  Effect.fromResult(translateEvent(endpoint.toolCalling, state, received)),
                onNone: () =>
                  Effect.fromResult(finished(state)).pipe(
                    Effect.tap(([done]) =>
                      // One provider turn's outcome as counts only: no prompt, reply, model, endpoint or key.
                      Effect.logInfo("Compatible model turn finished", {
                        finishReason: turnFinishReason(done),
                        toolDefinitions: payload.tools?.length ?? 0,
                        toolCalls: done.endedCalls,
                      }),
                    ),
                  ),
              }),
          ),
          Stream.catchTag("CompatibleRunRequestFailed", (failure) =>
            Stream.fromEffect(failWith(failure)),
          ),
          Stream.mapError((error) => withDiagnostic(error, diagnostic)),
        );
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetcher),
        // Never redirect credentials to another server.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    ).pipe(
      Stream.tapError((error) =>
        Effect.logError("compatible model request failed").pipe(
          Effect.annotateLogs({ code: failureCode(error) }),
        ),
      ),
    );

  return yield* LanguageModel.make({
    streamText,
    generateText: (request) => collectResponse(streamText(request)),
  });
});
