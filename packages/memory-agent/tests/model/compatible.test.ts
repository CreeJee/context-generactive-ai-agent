import { it } from "@effect/vitest";
// Native fetch fixtures implement the compatible endpoint the model sends to.
import { Effect, Logger, Option, Predicate, References, Schema, Stream } from "effect";
import { Prompt, Tool } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import type { JsonValue } from "../../src/json.ts";
import {
  compatibleBody,
  compatibleFailure,
  CompatibleRunRequestFailed,
  CompatibleRunRequestFailedReason,
  compatibleModel,
  compatibleRequest,
  compatibleTarget,
  shownCompatibleFailure,
  type CompatibleModelOptions,
} from "../../src/model/compatible.ts";
import { providerPrompt } from "../../src/model/history.ts";
import { toPrompt } from "../../src/model/prompt.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";

/**
 * The compatible model's contract (docs/effect-ai-migration.md step 2): what it sends and where,
 * what it emits for the endpoint's chunks, which failures its `AiError` carries, and what it never
 * logs. The request bodies are compared with TanStack's in requests.test.ts.
 */

const endpoint = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "local-model",
  contextWindow: 8192,
  outputBudget: 512,
  toolCalling: true,
  imageInput: true,
};

const prompt = Prompt.make([
  { role: "system", content: "Follow the rules." },
  { role: "user", content: "private question" },
]);

const systemPrompt = "Follow the rules.";

const chunk = (delta: JsonValue, finishReason: string | null = null) => ({
  id: "chunk-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "served-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const sse = (events: ReadonlyArray<JsonValue>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly body: string;
}

/** An endpoint that answers every request with `reply` and records what was sent. */
const endpointOf =
  (reply: () => Response, sent: Array<Sent> = []): typeof fetch =>
  (url, init) => {
    const body = init?.body;
    sent.push({
      url: url instanceof URL ? url.href : url instanceof Request ? url.url : url,
      init,
      body:
        body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : Predicate.isString(body)
            ? body
            : "",
    });
    return Promise.resolve(reply());
  };

const streamOf = (events: ReadonlyArray<JsonValue>) => () =>
  new Response(sse(events), { headers: { "Content-Type": "text/event-stream" } });

const options = (fetcher: typeof fetch): CompatibleModelOptions => ({
  endpoint,
  reasoningEffort: "default",
  key: null,
  fetcher,
});

/** The parts the model streams, with tool calls left for the caller as the agent loop leaves them. */
const partsOf = Effect.fnUntraced(function* (modelOptions: CompatibleModelOptions) {
  const model = yield* compatibleModel(modelOptions);
  return yield* Stream.runCollect(
    model.streamText({ prompt, disableToolCallResolution: true, toolCallValidation: "deferred" }),
  );
});

const failureOf = (modelOptions: CompatibleModelOptions) =>
  Effect.map(Effect.flip(partsOf(modelOptions)), (error) => ({
    error,
    failure: Option.getOrUndefined(compatibleFailure(error)),
  }));

const failed = (reason: CompatibleRunRequestFailed["reason"]) =>
  CompatibleRunRequestFailed.make({ reason });

// The body is the JSON text the model sent.
const parseBody = (sent: Sent | undefined): JsonValue => JSON.parse(sent?.body ?? "null");

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** What a test reads of a sent body: each message's role and content parts' types. */
const SentMessages = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      content: Schema.NullOr(
        Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String }))]),
      ),
    }),
  ),
});
const decodeSentMessages = Schema.decodeUnknownEffect(Schema.fromJsonString(SentMessages));

/** The request's body as the model sends it: `OpenAiClient` sets the stream fields again. */
const wireBodyOf = (payload: { readonly stream?: unknown; readonly stream_options?: unknown }) =>
  JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } });

const tools = [
  Tool.dynamic("lookup", {
    description: "Lookup",
    parameters: {
      type: "object",
      properties: { glob: { type: "string", format: "glob" } },
      additionalProperties: false,
    },
  }),
];

describe("compatible language model", () => {
  it.effect("sends its body to the endpoint with the key and refuses redirects", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const reply = streamOf([chunk({ content: "OK" }, "stop")]);
      yield* partsOf({
        ...options(endpointOf(reply, sent)),
        key: "secret-key",
        reasoningEffort: "high",
      });
      yield* partsOf({
        ...options(endpointOf(reply, sent)),
        endpoint: { ...endpoint, outputBudget: null },
      });
      const [keyed, unkeyed] = sent;
      expect(keyed?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(keyed?.init?.redirect).toBe("error");
      expect(new Headers(keyed?.init?.headers).get("authorization")).toBe("Bearer secret-key");
      expect(new Headers(unkeyed?.init?.headers).get("authorization")).toBeNull();
      expect(keyed?.body).toBe(
        yield* encodeJson(
          yield* compatibleBody({ endpoint, reasoningEffort: "high", prompt, tools: [] }),
        ),
      );
      expect(parseBody(keyed)).toMatchObject({ max_tokens: 512, reasoning_effort: "high" });
      expect(parseBody(unkeyed)).not.toHaveProperty("max_tokens");
      expect(parseBody(unkeyed)).not.toHaveProperty("reasoning_effort");
    }),
  );

  it.effect("sends tools non-strict as written, and none when tool calling is off", () =>
    Effect.gen(function* () {
      const body = yield* compatibleBody({ endpoint, reasoningEffort: "default", prompt, tools });
      // Strict mode would make `glob` required; the `format` stays as the tool wrote it.
      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup",
            parameters: {
              type: "object",
              properties: { glob: { type: "string", format: "glob" } },
              additionalProperties: false,
            },
            strict: false,
          },
        },
      ]);
      const off = yield* compatibleBody({
        endpoint: { ...endpoint, toolCalling: false },
        reasoningEffort: "default",
        prompt,
        tools,
      });
      expect(off).not.toHaveProperty("tools");
    }),
  );

  it.effect.each(["reasoning_content", "reasoning", "reasoning_text"])(
    "streams %s as reasoning that ends when the answer starts",
    (field) =>
      Effect.gen(function* () {
        const parts = yield* partsOf(
          options(
            endpointOf(
              streamOf([
                chunk({ [field]: "Compare the values." }),
                chunk({ content: "The answer is 42." }),
                chunk({}, "stop"),
              ]),
            ),
          ),
        );
        expect(parts.map((part) => part.type)).toEqual([
          "reasoning-start",
          "reasoning-delta",
          "reasoning-end",
          "text-start",
          "text-delta",
          "text-end",
          "response-metadata",
          "finish",
        ]);
        expect(parts).toContainEqual(
          expect.objectContaining({ type: "reasoning-delta", delta: "Compare the values." }),
        );
        expect(parts).toContainEqual(
          expect.objectContaining({ type: "response-metadata", modelId: "served-model" }),
        );
      }),
  );

  it.effect("streams calls as TanStack read their deltas, with the usage tail", () =>
    Effect.gen(function* () {
      const parts = yield* partsOf(
        options(
          endpointOf(
            streamOf([
              // The arguments come before the id; deltas without an index follow the last call.
              chunk({ tool_calls: [{ function: { name: "lookup", arguments: '{"q":' } }] }),
              chunk({ tool_calls: [{ id: "call-1", function: { arguments: '"x"}' } }] }),
              chunk({ tool_calls: [{ id: "call-2", function: { name: "list", arguments: "" } }] }),
              chunk({ tool_calls: [{ index: 2, function: { name: "never-started" } }] }),
              chunk({}, "tool_calls"),
              {
                ...chunk({}),
                choices: [],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 3,
                  total_tokens: 13,
                  prompt_tokens_details: { cached_tokens: 4 },
                  completion_tokens_details: { reasoning_tokens: 2 },
                },
              },
            ]),
          ),
        ),
      );
      expect(parts.filter((part) => part.type === "tool-call")).toEqual([
        expect.objectContaining({
          id: "call-1",
          name: "lookup",
          params: { q: "x" },
          metadata: { "memory-agent": { arguments: '{"q":"x"}' } },
        }),
        expect.objectContaining({ id: "call-2", name: "list", params: {} }),
      ]);
      expect(parts).toContainEqual(
        expect.objectContaining({ type: "tool-params-delta", id: "call-1", delta: '{"q":' }),
      );
      expect(parts.at(-1)).toMatchObject({
        type: "finish",
        reason: "tool-calls",
        usage: {
          inputTokens: { total: 10, uncached: 6, cacheRead: 4 },
          outputTokens: { total: 3, reasoning: 2 },
        },
      });
    }),
  );

  it.effect("refuses a request over the context window before sending it", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = [];
      const { failure } = yield* failureOf({
        ...options(endpointOf(streamOf([]), sent)),
        endpoint: { ...endpoint, contextWindow: 1024, outputBudget: 1000 },
      });
      expect(failure).toEqual(
        failed(CompatibleRunRequestFailedReason.cases.ContextLimitExceeded.make({})),
      );
      expect(sent).toEqual([]);
    }),
  );

  it.effect("replays earlier images as notes when only then the request fits", () =>
    Effect.gen(function* () {
      const image: StoredMessage = {
        role: "user",
        content: [
          { type: "text", content: "look" },
          { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        ],
      };
      const request = (messages: ReadonlyArray<StoredMessage>) =>
        compatibleRequest({
          endpoint: { ...endpoint, contextWindow: 2_000 },
          reasoningEffort: "default",
          prompt: providerPrompt(
            toPrompt([...messages, { role: "user", content: "next" }], [systemPrompt]),
            compatibleTarget(endpoint.model),
          ),
          tools: [],
        }).pipe(Effect.map(wireBodyOf));
      // The request with both images does not fit at this window; the newest one stays and the
      // earlier one leaves as the note.
      const sent = yield* request([image, image]);
      expect(yield* decodeJson(sent)).toMatchObject({
        messages: [
          { role: "system" },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "text", text: "[image from an earlier message]" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
          { role: "user", content: "next" },
        ],
      });
      // A window the last image alone cannot fit, even after the pass: still refused.
      yield* Effect.flip(
        compatibleRequest({
          endpoint: { ...endpoint, contextWindow: 24, outputBudget: null },
          reasoningEffort: "default",
          prompt: providerPrompt(
            toPrompt([image, { role: "user", content: "next" }], [systemPrompt]),
            compatibleTarget(endpoint.model),
          ),
          tools: [],
        }),
      );
    }),
  );

  it.effect("counts images at a fixed token budget, not their base64 characters", () =>
    Effect.gen(function* () {
      // An image whose base64 characters alone, at a quarter token each, would count over the window.
      const data = "A".repeat(80_000);
      const image: StoredMessage = {
        role: "user",
        content: [
          { type: "text", content: "look" },
          { type: "image", source: { type: "data", value: data, mimeType: "image/png" } },
        ],
      };
      const request = (messages: ReadonlyArray<StoredMessage>) =>
        compatibleRequest({
          endpoint: { ...endpoint, contextWindow: 10_000, outputBudget: 512 },
          reasoningEffort: "default",
          prompt: providerPrompt(
            toPrompt(messages, [systemPrompt]),
            compatibleTarget(endpoint.model),
          ),
          tools: [],
        }).pipe(Effect.map(wireBodyOf));
      // One image at `tokensPerImage` plus the text fits the window and keeps the image part.
      const sent = yield* request([{ role: "user", content: "next" }, image]);
      expect(yield* decodeJson(sent)).toMatchObject({
        messages: [
          { role: "system" },
          { role: "user", content: "next" },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
            ],
          },
        ],
      });
      // Ten of them, at the fixed budget, leave every image but the newest message's as the note.
      const slimmed = yield* request(Array.from({ length: 10 }, () => image));
      const body = yield* decodeSentMessages(slimmed);
      // The newest image message is this turn's, so the newest image stays with it.
      expect(body.messages.filter((message) => message.role === "user")).toHaveLength(10);
      expect(
        body.messages.filter(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image_url"),
        ),
      ).toEqual([body.messages.at(-1)]);
    }),
  );

  it.effect("replays an earlier image as a note to a model without image input", () =>
    Effect.gen(function* () {
      const body = yield* compatibleBody({
        endpoint: { ...endpoint, imageInput: false },
        reasoningEffort: "default",
        prompt: providerPrompt(
          toPrompt(
            [
              {
                role: "user",
                content: [
                  { type: "text", content: "look" },
                  { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
                ],
              },
              { role: "user", content: "what was it?" },
            ],
            [systemPrompt],
          ),
          compatibleTarget(endpoint.model),
        ),
        tools: [],
      });
      expect(body.messages).toEqual([
        { role: "system", content: "Follow the rules." },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "text", text: "[image from an earlier message]" },
          ],
        },
        { role: "user", content: "what was it?" },
      ]);
    }),
  );

  it.effect("fails when the model calls a tool while tool calling is off", () =>
    Effect.gen(function* () {
      const { failure } = yield* failureOf({
        ...options(
          endpointOf(
            streamOf([
              chunk({ tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup" } }] }),
              chunk({}, "tool_calls"),
            ]),
          ),
        ),
        endpoint: { ...endpoint, toolCalling: false },
      });
      expect(failure).toEqual(
        failed(CompatibleRunRequestFailedReason.cases.ToolCallingDisabled.make({})),
      );
    }),
  );

  it.effect("adds the request's shape to a template error, never its content", () =>
    Effect.gen(function* () {
      const { error } = yield* failureOf(
        options(
          endpointOf(() =>
            Response.json(
              {
                error: {
                  message: "No user query found in messages.",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            ),
          ),
        ),
      );
      expect(error.reason._tag).toBe("InvalidRequestError");
      expect(error.message).toContain(
        "Compatible request messages: total=2, user=1, assistant=0, tool=0, first=system, last=user",
      );
      expect(error.message).toContain(
        "model=local-model, toolDefinitions=0, userContent=[text:16:plain]",
      );
      expect(error.message).not.toContain("private question");
    }),
  );

  it.effect("shows a rejection's status and error type, never the provider's text", () =>
    Effect.gen(function* () {
      const { error } = yield* failureOf(
        options(
          endpointOf(() =>
            Response.json(
              {
                error: {
                  code: 400,
                  message: "request (9000 tokens) exceeds the available context size (8192 tokens)",
                  type: "exceed_context_size_error",
                },
              },
              { status: 400 },
            ),
          ),
        ),
      );
      expect(shownCompatibleFailure(error)).toEqual({
        message: "The provider rejected the request. (HTTP 400, exceed_context_size_error)",
      });
    }),
  );

  it.effect("fails a stream without a finish reason, with an unknown one, or with an error", () =>
    Effect.gen(function* () {
      const cases = [
        [[chunk({ content: "cut" })], "without a finish_reason"],
        [[chunk({ content: "odd" }, "paused")], "Provider finish_reason: paused"],
        [[{ error: { message: "model crashed" } }], "model crashed"],
      ] as const;
      yield* Effect.forEach(
        cases,
        ([events, message]) =>
          Effect.map(failureOf(options(endpointOf(streamOf(events)))), ({ error }) =>
            expect(error.message).toContain(message),
          ),
        { discard: true },
      );
    }),
  );

  it.effect("fails an answer whose connection dropped as disconnected, logging its codes", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const capture = Logger.make((log) => {
        logs.push(Logger.formatStructured.log(log));
      });
      // The first chunk arrives, then the socket closes as undici reports it.
      const reads = [
        new TextEncoder().encode(`data: ${yield* encodeJson(chunk({ content: "Half" }))}\n\n`),
      ];
      const dropped = new TypeError("terminated", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      });
      const { error, failure } = yield* failureOf(
        options(
          endpointOf(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  pull: (controller) => {
                    const next = reads.shift();
                    return next === undefined
                      ? controller.error(dropped)
                      : controller.enqueue(next);
                  },
                }),
                { headers: { "Content-Type": "text/event-stream" } },
              ),
          ),
        ),
      ).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        Effect.provideService(References.MinimumLogLevel, "Trace"),
      );
      // The run's error carries the codes too: a report from another device has no logs.
      expect(failure).toEqual(
        failed(
          CompatibleRunRequestFailedReason.cases.Disconnected.make({ codes: ["UND_ERR_SOCKET"] }),
        ),
      );
      expect(shownCompatibleFailure(error)).toEqual({
        message: "Compatible API connection closed before the answer finished: UND_ERR_SOCKET",
      });
      expect(yield* encodeJson(logs)).toContain(
        "Compatible API connection closed before the answer finished: UND_ERR_SOCKET",
      );
    }),
  );

  it.effect("logs and shows a failed fetch by its transport codes only", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const capture = Logger.make((log) => {
        logs.push(Logger.formatStructured.log(log));
      });
      const { error } = yield* failureOf(
        options(() =>
          Promise.reject(
            new TypeError("fetch failed", {
              cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
            }),
          ),
        ),
      ).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
        Effect.provideService(References.MinimumLogLevel, "Trace"),
      );
      expect(error.reason._tag).toBe("NetworkError");
      // The run's error says how the connection failed, so a report tells a refused connection
      // from one that timed out.
      expect(shownCompatibleFailure(error)).toEqual({
        message: "The provider could not be reached. (ECONNREFUSED)",
      });
      expect(logs).not.toHaveLength(0);
      const written = yield* encodeJson(logs);
      expect(written).not.toContain("127.0.0.1");
      expect(written).not.toContain("private question");
    }),
  );
});
