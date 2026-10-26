import { OpenAiClient } from "@effect/ai-openai-compat";
import {
  Context,
  Effect,
  type JsonSchema,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";
import {
  reservedOutput,
  type OpenAICompatibleConfiguration,
} from "../providers/openai-compatible-config.ts";
import { isTruthy } from "../truthy.ts";
import { providerPrompt, type ReplayTarget } from "./history.ts";
import { optionsKey, partOptions, toolResultContent, type StoredContent } from "./prompt.ts";
import { collectResponse } from "./response.ts";

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
export class CompatibleRunRequestFailed extends Schema.TaggedError<CompatibleRunRequestFailed>()(
  "CompatibleRunRequestFailed",
  {
    reason: CompatibleRunRequestFailedReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
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
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let index = 0; index < id.length; index++) {
    const character = id.charCodeAt(index);
    h1 = Math.imul(h1 ^ character, 2654435761);
    h2 = Math.imul(h2 ^ character, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
};

const idSafe = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The id another model's call gets, as TanStack's Chat Completions adapter renamed it. */
const compatibleToolCallId = (id: string, attempt: number) => {
  if (attempt > 0)
    return `${idSafe(id.split("|")[0] ?? "").slice(0, 31) || "call"}_${hashToolCallId(
      `${id}:${attempt}`,
    ).slice(0, 8)}`;
  const separator = id.indexOf("|");
  if (separator === -1) return id;
  const call = idSafe(id.slice(0, separator));
  const item = idSafe(id.slice(separator + 1));
  const combined = item === "" ? call : `${call}_${item}`;
  return combined.length <= 40
    ? combined
    : `${call.slice(0, 31)}_${hashToolCallId(id).slice(0, 8)}`;
};

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
const toolContent = (content: StoredContent) => {
  if (Predicate.isString(content)) return content;
  if (!content.some((part) => part.type === "image")) return JSON.stringify(content);
  const text = content.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("");
  return text === "" ? "(see attached image)" : text;
};

/** The images of tool result content, which go to the model in a user message after it. */
const toolImages = (content: StoredContent): Array<ChatContentPart> =>
  Predicate.isString(content)
    ? []
    : content.flatMap((part) => (part.type === "image" ? [imageUrlPart(part.source)] : []));

/** The arguments as the model sent them; the encoded parameters for a call made elsewhere. */
const callArguments = (part: Prompt.ToolCallPart) =>
  partOptions(part).arguments ?? JSON.stringify(part.params);

const userMessage = Effect.fnUntraced(function* (message: Prompt.UserMessage) {
  const [first, ...rest] = message.content;
  if (first?.type === "text" && rest.length === 0) {
    if (first.text === "")
      return yield* invalidRequest(
        "User message for openai-compatible has empty text content. Empty user messages would produce a paid request with no input; provide non-empty content or omit the message.",
      );
    return { role: "user", content: first.text } satisfies ChatMessage;
  }
  if (first === undefined)
    return yield* invalidRequest(
      "User message for openai-compatible has no content parts. Empty user messages would produce a paid request with no input; provide at least one text/image/audio part or omit the message.",
    );
  return {
    role: "user",
    content: message.content.map((part): ChatContentPart =>
      part.type === "text" ? { type: "text", text: part.text } : imageUrlPart(imageSource(part)),
    ),
  } satisfies ChatMessage;
});

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

/**
 * The Chat Completions messages for a prompt that is already the provider prompt: the system
 * prompts joined first, and each tool result's images in a user message after the results.
 */
const chatMessages = Effect.fnUntraced(function* (prompt: Prompt.Prompt) {
  const messages: Array<ChatMessage> = [];
  const system = prompt.content.flatMap((message) =>
    message.role === "system" ? [message.content] : [],
  );
  if (system.length > 0) messages.push({ role: "system", content: system.join("\n") });
  const images: Array<ChatContentPart> = [];
  for (const message of prompt.content) {
    if (message.role === "system") continue;
    if (message.role !== "tool" && images.length > 0)
      messages.push({ role: "user", content: images.splice(0) });
    switch (message.role) {
      case "user":
        messages.push(yield* userMessage(message));
        break;
      case "assistant":
        messages.push(assistantMessage(message));
        break;
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          const content = toolResultContent(part);
          messages.push({ role: "tool", tool_call_id: part.id, content: toolContent(content) });
          images.push(...toolImages(content));
        }
        break;
    }
  }
  if (images.length > 0) messages.push({ role: "user", content: images });
  return messages;
});

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
      parameters: Tool.getJsonSchema(tool),
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
  let estimated = 0;
  for (const character of JSON.stringify(payload))
    estimated += character.charCodeAt(0) < 128 ? 0.25 : 1;
  return Math.ceil(estimated) + reservedOutput(endpoint.outputBudget) > endpoint.contextWindow;
};

/**
 * The request's shape for a template's "No user query found in messages" error: counts, roles,
 * the model and what kind of user content it sent, never the content (decisions.md 2026-10-04).
 */
const requestDiagnostic = (payload: CompatiblePayload) => {
  const { messages } = payload;
  const count = (role: ChatMessage["role"]) =>
    messages.filter((message) => message.role === role).length;
  const userContent = messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const { content } = message;
    if (Predicate.isString(content)) {
      const text = content.trim();
      const wrapped = text.startsWith("<tool_response>") && text.endsWith("</tool_response>");
      return [`text:${content.length}:${wrapped ? "tool-response" : "plain"}`];
    }
    return [content === null ? "empty" : `parts:${content.length}`];
  });
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
const errorMessage = (error: JsonValue) => {
  const message =
    Predicate.isObject(error) && Predicate.hasProperty(error, "message") ? error.message : null;
  if (!isTruthy(message)) return JSON.stringify(error);
  return Predicate.isString(message) ? message : JSON.stringify(message);
};

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

const finishUsage = (usage: Usage | undefined) => {
  if (usage === undefined) return { inputTokens: {}, outputTokens: {} };
  const total = usage.prompt_tokens ?? 0;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || undefined;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens || undefined;
  return {
    inputTokens: {
      total,
      uncached: total - (cacheRead ?? 0) - (cacheWrite ?? 0),
      ...optionalProperty("cacheRead", cacheRead),
      ...optionalProperty("cacheWrite", cacheWrite),
    },
    outputTokens: {
      total: usage.completion_tokens ?? 0,
      ...optionalProperty(
        "reasoning",
        usage.completion_tokens_details?.reasoning_tokens || undefined,
      ),
    },
  };
};

interface StreamingCall {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

/**
 * Turns Chat Completions chunks into response parts, one chunk at a time, as TanStack's
 * `processStreamChunks` did: one reasoning block until the text starts, one text block until the
 * finish reason, and calls that start once their id and name are known and end at the finish
 * reason. A call that never got both is dropped.
 */
const makeTranslator = (toolCalling: boolean) => {
  let chunks = 0;
  let textId: string | undefined;
  let texts = 0;
  let reasoningId: string | undefined;
  let reasonings = 0;
  let responseId: string | undefined;
  let modelId: string | undefined;
  let usage: Usage | undefined;
  let endsWithUsage = false;
  let finishReason: string | undefined;
  let endedCalls = 0;
  const calls = new Map<number, StreamingCall>();
  let latest: { readonly index: number; readonly id: string; readonly name: string } | undefined;

  const closeText = (): Array<Part> => {
    if (textId === undefined) return [];
    const id = textId;
    textId = undefined;
    return [{ type: "text-end", id }];
  };

  const closeReasoning = (): Array<Part> => {
    if (reasoningId === undefined) return [];
    const id = reasoningId;
    reasoningId = undefined;
    return [{ type: "reasoning-end", id }];
  };

  const endCalls = (): Array<Part> => {
    const parts: Array<Part> = [];
    for (const call of calls.values()) {
      if (!call.started) continue;
      endedCalls++;
      parts.push(
        { type: "tool-params-end", id: call.id },
        {
          type: "tool-call",
          id: call.id,
          name: call.name,
          params: paramsOf(call.arguments),
          ...argumentsMetadata(call.arguments),
        },
      );
    }
    calls.clear();
    return parts;
  };

  /** The slot a call delta belongs to, as TanStack resolved deltas without an index. */
  const callIndex = (delta: (typeof ToolCallDelta)["Type"]) => {
    const id = delta.id ?? "";
    const name = delta.function?.name ?? "";
    const startsNext =
      latest !== undefined &&
      ((id !== "" && latest.id !== "" && id !== latest.id) ||
        (id !== "" &&
          latest.id === "" &&
          name !== "" &&
          latest.name !== "" &&
          name !== latest.name) ||
        (id === "" && name !== "" && latest.name !== "" && name !== latest.name));
    if (Predicate.isNumber(delta.index)) return delta.index;
    if (latest === undefined) return 0;
    if (!startsNext) return latest.index;
    let index = latest.index + 1;
    while (calls.has(index)) index += 1;
    return index;
  };

  const callDelta = Effect.fnUntraced(function* (delta: (typeof ToolCallDelta)["Type"]) {
    const index = callIndex(delta);
    const call = calls.get(index) ?? {
      id: delta.id ?? "",
      name: delta.function?.name ?? "",
      arguments: "",
      started: false,
    };
    calls.set(index, call);
    if (isTruthy(delta.id)) call.id = delta.id;
    if (isTruthy(delta.function?.name)) call.name = delta.function.name;
    latest = { index, id: call.id, name: call.name };
    const added = delta.function?.arguments ?? "";
    call.arguments += added;
    const parts: Array<Part> = [];
    if (call.id !== "" && call.name !== "" && !call.started) {
      if (!toolCalling) return yield* toolCallingDisabled();
      call.started = true;
      parts.push({ type: "tool-params-start", id: call.id, name: call.name });
      // Arguments that came before the id and name are sent with the start.
      const before = call.arguments.slice(0, call.arguments.length - added.length);
      if (before !== "") parts.push({ type: "tool-params-delta", id: call.id, delta: before });
    }
    if (added !== "" && call.started)
      parts.push({ type: "tool-params-delta", id: call.id, delta: added });
    return parts;
  });

  const step = Effect.fnUntraced(function* (
    event: OpenAiClient.ChatCompletionStreamEvent,
  ): Effect.fn.Return<Array<Part>, AiError.AiError | CompatibleRunRequestFailed> {
    if (event === "[DONE]") return [];
    // Servers vary: whatever parsed is read for the fields TanStack read.
    const raw = "_tag" in event ? event.data : event;
    const chunk: Chunk | undefined = Option.getOrUndefined(decodeChunk(raw));
    if (chunk === undefined) return yield* invalidOutput("Invalid Chat Completions chunk");
    if (isTruthy(chunk.error)) return yield* providerError(chunk.error);
    chunks++;
    const choices = chunk.choices ?? [];
    endsWithUsage = choices.length === 0 && chunk.usage !== undefined && chunk.usage !== null;
    if (isTruthy(chunk.usage)) usage = Option.getOrUndefined(decodeUsage(chunk.usage)) ?? usage;
    if (Predicate.isString(chunk.id) && chunk.id !== "") responseId = chunk.id;
    if (Predicate.isString(chunk.model) && chunk.model !== "") modelId = chunk.model;
    const delta = choices[0]?.delta ?? {};
    const parts: Array<Part> = [];
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
    if (Predicate.isString(reasoning) && reasoning !== "") {
      if (reasoningId === undefined) {
        reasoningId = `reasoning-${reasonings++}`;
        parts.push({ type: "reasoning-start", id: reasoningId });
      }
      parts.push({ type: "reasoning-delta", id: reasoningId, delta: reasoning });
    }
    const choice = choices[0];
    if (choice === undefined) return parts;
    if (isTruthy(delta.content)) {
      parts.push(...closeReasoning());
      if (textId === undefined) {
        textId = `text-${texts++}`;
        parts.push({ type: "text-start", id: textId });
      }
      parts.push({ type: "text-delta", id: textId, delta: delta.content });
    }
    for (const call of delta.tool_calls ?? []) parts.push(...(yield* callDelta(call)));
    if (isTruthy(choice.finish_reason)) {
      if (choice.finish_reason === "tool_calls" || calls.size > 0) parts.push(...endCalls());
      parts.push(...closeText());
      finishReason = choice.finish_reason;
    }
    return parts;
  });

  /** The turn's reason as TanStack reported it: a call makes it `tool_calls`. */
  const turnFinishReason = (): FinishReason => {
    if (finishReason === "length") return "length";
    if (endedCalls > 0) return "tool_calls";
    if (finishReason === "tool_calls") return "stop";
    return finishReason !== undefined && isFinishReason(finishReason) ? finishReason : "stop";
  };

  const finish = Effect.suspend((): Effect.Effect<Array<Part>, AiError.AiError> => {
    const ended = [...endCalls(), ...closeText(), ...closeReasoning()];
    if (chunks === 0 || (finishReason === undefined && !endsWithUsage))
      return Effect.fail(
        invalidOutput("Chat Completions stream ended without a finish_reason or usage-only tail"),
      );
    if (finishReason !== undefined && !isFinishReason(finishReason))
      return Effect.fail(invalidOutput(`Provider finish_reason: ${finishReason}`));
    return Effect.succeed([
      ...ended,
      {
        type: "response-metadata",
        ...optionalProperty("id", responseId),
        ...optionalProperty("modelId", modelId),
      },
      { type: "finish", reason: finishReasons[turnFinishReason()], usage: finishUsage(usage) },
    ]);
  });

  return { step, finish, turnFinishReason, calls: () => endedCalls };
};

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
export const compatibleRequest = Effect.fnUntraced(function* (request: CompatibleRequest) {
  const payload = yield* compatibleBody(request);
  if (exceedsContext(payload, request.endpoint))
    return yield* failWith(
      CompatibleRunRequestFailed.make({
        reason: CompatibleRunRequestFailedReason.cases.ContextLimitExceeded.make({}),
      }),
    );
  return payload;
});

/** The app failure an `AiError` from a compatible model carries. */
export const compatibleFailure = (
  error: AiError.AiError,
): Option.Option<CompatibleRunRequestFailed> =>
  error.reason._tag === "UnknownError"
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

/** What the error log says about a failure: its reason, never provider text. */
const failureCode = (error: AiError.AiError) =>
  Option.match(compatibleFailure(error), {
    onNone: () => error.reason._tag,
    onSome: (failure) => failure.reason._tag,
  });

/** Node/undici transport codes (`ECONNRESET`, `ETIMEDOUT`, ...) surfaced from fetch failures. */
const isTransportErrorCode = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Z0-9_]+$/)));

/** The transport codes along a failed fetch's cause chain; never URLs, headers or payloads. */
const transportCodes = (error: HttpClientError.HttpClientError) => {
  const codes: string[] = [];
  if (error.reason._tag !== "TransportError") return codes;
  const seen: Array<Error> = [];
  let current = error.reason.cause;
  while (Predicate.isError(current) && !seen.includes(current) && seen.length < 8) {
    seen.push(current);
    if (Predicate.hasProperty(current, "code") && isTransportErrorCode(current.code))
      codes.push(current.code);
    current = current.cause;
  }
  return codes;
};

/** One run's compatible model: its endpoint, effort and key stay fixed for every step. */
export interface CompatibleModelOptions {
  readonly endpoint: OpenAICompatibleConfiguration;
  readonly reasoningEffort: string;
  /** Read by the caller for this endpoint; none sends no authorization. */
  readonly key: string | null;
  readonly fetcher: typeof globalThis.fetch;
}

export const makeCompatibleModel = Effect.fnUntraced(function* (options: CompatibleModelOptions) {
  const { endpoint, reasoningEffort, fetcher } = options;
  // The fetch client has no resources; its scope only builds it.
  const http = yield* Effect.scoped(Layer.build(FetchHttpClient.layer)).pipe(
    Effect.map((services) => Context.get(services, HttpClient.HttpClient)),
  );
  const client = yield* OpenAiClient.make({
    apiUrl: endpoint.baseUrl,
    apiKey: isTruthy(options.key) ? Redacted.make(options.key) : undefined,
    transformClient: HttpClient.tapError((error) => {
      if (error.reason._tag !== "TransportError") return Effect.void;
      // Do not log URLs, headers or payloads: the transport codes say what failed.
      return Effect.logError(
        CompatibleRunRequestFailed.make({
          reason: CompatibleRunRequestFailedReason.cases.Transport.make({
            codes: transportCodes(error),
          }),
        }).message,
      );
    }),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const streamText = (request: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (request.responseFormat.type === "json")
          return yield* invalidRequest("Compatible models do not support structured output.");
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
        const translator = makeTranslator(endpoint.toolCalling);
        const [, events] = yield* client
          .createResponseStream(payload)
          .pipe(Effect.mapError((error) => withDiagnostic(error, diagnostic)));
        return events.pipe(
          Stream.mapEffect(translator.step),
          Stream.concat(Stream.fromEffect(translator.finish)),
          Stream.flatMap(Stream.fromIterable),
          Stream.tap((part) =>
            part.type === "finish"
              ? // One provider turn's outcome as counts only: no prompt, reply, model, endpoint or key.
                Effect.logInfo("Compatible model turn finished", {
                  finishReason: translator.turnFinishReason(),
                  toolDefinitions: payload.tools?.length ?? 0,
                  toolCalls: translator.calls(),
                })
              : Effect.void,
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
