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
  makeCompatibleModel,
  type CompatibleModelOptions,
} from "../../src/model/compatible.ts";

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
};

const prompt = Prompt.make([
  { role: "system", content: "Follow the rules." },
  { role: "user", content: "private question" },
]);

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

/** A response that sends `event` and then keeps the connection open. */
const openStream = (event: JsonValue) =>
  new Response(
    new ReadableStream({
      start: (controller) =>
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

const options = (fetcher: typeof fetch): CompatibleModelOptions => ({
  endpoint,
  reasoningEffort: "default",
  key: null,
  fetcher,
});

/** The parts the model streams, with tool calls left for the caller as the agent loop leaves them. */
const partsOf = Effect.fnUntraced(function* (modelOptions: CompatibleModelOptions) {
  const model = yield* makeCompatibleModel(modelOptions);
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

  it.effect("fails a stream without a finish reason, with an unknown one, or with an error", () =>
    Effect.gen(function* () {
      const cases = [
        [[chunk({ content: "cut" })], "without a finish_reason"],
        [[chunk({ content: "odd" }, "paused")], "Provider finish_reason: paused"],
        [[{ error: { message: "model crashed" } }], "model crashed"],
      ] as const;
      for (const [events, message] of cases) {
        const { error } = yield* failureOf(options(endpointOf(streamOf(events))));
        expect(error.message).toContain(message);
      }
    }),
  );

  it.effect("logs a failed fetch by its transport codes only", () =>
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
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "ERROR",
          message: "Compatible API request failed: ECONNREFUSED",
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          message: "compatible model request failed",
          annotations: { code: "NetworkError" },
        }),
      );
      const written = yield* encodeJson(logs);
      expect(written).not.toContain("127.0.0.1");
      expect(written).not.toContain("private question");
    }),
  );

  it.effect("aborts the request when the stream is interrupted", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const model = yield* makeCompatibleModel(
        options((_url, init) => {
          signal = init?.signal ?? undefined;
          return Promise.resolve(openStream(chunk({ content: "partial" })));
        }),
      );
      const parts = yield* Stream.runCollect(
        model
          .streamText({ prompt, disableToolCallResolution: true })
          .pipe(Stream.takeUntil((part) => part.type === "text-delta")),
      );
      expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta"]);
      expect(signal?.aborted).toBe(true);
    }),
  );
});
