import { GlobalConfigFailed } from "../src/config/global-config.ts";
import { it as effectTest } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { TestClock } from "effect/testing";
import { Result, Function as EffectFunction } from "effect";
// Native SDK fetch, keyring and AsyncGenerator adapters remain explicit Promise boundaries.
import { testHttpServer, HttpServerRequest, HttpServerResponse } from "./support/http.ts";
import { DatabaseSync } from "node:sqlite";
import { chat } from "@tanstack/ai";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { GlobalConfig } from "../src/config/global-config.ts";
import { ActiveProvider } from "../src/providers/active-provider.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { describe, expect } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import { sqliteChatPersistence } from "../src/chat-state/persistence.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  makeOpenAICompatibleSettings,
  CompatibleCompletionRejected,
  OpenAICompatibleFailed,
  validateCompatibleConfiguration,
} from "../src/providers/openai-compatible.ts";

/** Native fetch fixture: interruption comes from the Effect running model discovery. */
const stalledFetch =
  (observe: (signal: AbortSignal | undefined) => void): typeof fetch =>
  (_url, init) => {
    const signal = init?.signal ?? undefined;
    observe(signal);
    return Effect.runPromise(Effect.never, { signal });
  };

const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
const nativeEffect = <A>(program: Effect.Effect<A, Cause.UnknownError>) =>
  Effect.runPromise(Effect.result(program)).then(
    Result.match({
      onSuccess: (value) => value,
      onFailure: (failure) => Promise.reject(failure.cause),
    }),
  );
const nativeFetch =
  (
    reply: (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => Effect.Effect<Response, Cause.UnknownError>,
  ): typeof fetch =>
  (input, init) =>
    nativeEffect(reply(input, init));
const nativeWrite =
  (write: (value: string | null) => Effect.Effect<void, Cause.UnknownError>) =>
  (value: string | null) =>
    nativeEffect(write(value));
// Wire fixtures encode synchronously at the SDK boundary; Effect assertions use typed decoders.
const jsonStringify = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const jsonParse = EffectFunction.flow(
  Schema.decodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const configuration = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "manual-model",
  contextWindow: 8192,
  outputBudget: 512,
  toolCalling: true,
};
const ChatRequest = Schema.Struct({
  max_tokens: Schema.optional(Schema.Int),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});
function fixture(fetcher?: typeof fetch, initial: Settings = {}) {
  let saved: Settings = initial;
  let key: string | null = null;
  const config = {
    // Asynchronous like the real config file read.
    read: Effect.promise(() => Promise.resolve(saved)),
    update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
  };
  const keys = {
    get: () => Promise.resolve(key),
    set: nativeWrite((value: string | null) =>
      Effect.sync(() => {
        key = value;
      }),
    ),
  };
  return {
    config,
    api: makeOpenAICompatibleSettings({ config: config, keys: keys, fetcher: fetcher }),
    restore: () => makeOpenAICompatibleSettings({ config: config, keys: keys, fetcher: fetcher }),
    saved: () => saved,
  };
}
describe("OpenAI compatible settings", () => {
  effectTest.live.each([
    [100, 80, "memory_capacity_exceeded"],
    [60, 80, "request_rejected"],
    [-100, 80, "request_rejected"],
  ] as const)(
    "classifies structured capacity rejection (%s / %s) without response text",
    ([estimated, limit, reason]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const privateText = "private endpoint, model, request and credential";
          const f = fixture(
            nativeFetch(() =>
              Effect.sync(() =>
                Response.json(
                  {
                    error: {
                      message: privateText,
                      estimated_bytes: estimated,
                      limit_bytes: limit,
                    },
                  },
                  { status: 400 },
                ),
              ),
            ),
            { openaiCompatible: configuration },
          );
          const client = yield* f.api.pinRrsiClient;
          const failure = yield* sdkCall(() =>
            client
              .complete('{"messages":[]}', new AbortController().signal)
              .catch((error: Error) => error),
          );
          expect(failure).toBeInstanceOf(CompatibleCompletionRejected);
          expect(failure).toMatchObject({ status: 400, reason });
          expect(jsonStringify(failure)).not.toContain(privateText);
        }),
      ),
  );

  effectTest.live("keeps unstructured provider rejections generic", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(
          nativeFetch(() =>
            Effect.sync(() => new Response("private provider traceback", { status: 502 })),
          ),
          {
            openaiCompatible: configuration,
          },
        );
        const client = yield* f.api.pinRrsiClient;
        expect(
          (yield* Effect.flip(
            sdkCall(() => client.complete('{"messages":[]}', new AbortController().signal)),
          )).cause,
        ).toMatchObject({ status: 502, reason: "request_rejected" });
      }),
    ),
  );
  effectTest.live("pins remote compatible endpoints and honors the configured output budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: string[] = [];
        const f = fixture(
          nativeFetch((url, options) =>
            Effect.sync(() => {
              expect(url).toBe("https://compatible.example/v1/chat/completions");
              seen.push(
                EffectFunction.flow(
                  Schema.decodeUnknownResult(Schema.String),
                  Result.getOrThrow,
                )(options?.body),
              );
              return Response.json({
                choices: [{ message: { content: "OK" } }],
                usage: { prompt_tokens: 2000000, completion_tokens: 1 },
              });
            }),
          ),
          {
            provider: "openai-compatible",
            model: "remote",
            reasoningEffort: "default",
            openaiCompatible: {
              ...configuration,
              baseUrl: "https://compatible.example/v1",
              model: "remote",
              outputBudget: 8192,
              contextWindow: 32768,
            },
          },
        );
        const client = yield* f.api.pinRrsiClient;
        yield* sdkCall(() =>
          client.complete(
            jsonStringify({
              model: "candidate-model",
              max_tokens: 1,
              messages: [{ role: "user", content: "hello" }],
            }),
            new AbortController().signal,
          ),
        );
        expect(jsonParse(seen[0]!)).toMatchObject({ model: "remote", max_tokens: 8192 });
      }),
    ),
  );

  effectTest.live.each([
    ["private question", "text:16:plain"],
    ["<tool_response>private result</tool_response>", "text:45:tool-response"],
  ])("reports wire query shapes without exposing content (%s)", ([content, diagnostic]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(
          nativeFetch(() =>
            Effect.sync(() =>
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
        yield* f.api.update(configuration);
        const adapter = (yield* f.api.runtime).adapter({
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "default",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
        try {
          const errors: string[] = [];
          yield* Stream.runForEach(
            Stream.fromAsyncIterable(
              adapter.chatStream({
                logger: resolveDebugOption(false),
                model: configuration.model,
                messages: [{ role: "user", content }],
              }),
              (cause) => new Cause.UnknownError(cause),
            ),
            (chunk) =>
              Effect.sync(() => {
                switch (chunk.type) {
                  case "RUN_ERROR":
                    errors.push(chunk.message);
                    break;
                }
              }),
          );
          expect(errors).toHaveLength(1);
          expect(errors[0]).toContain(
            "Compatible request messages: total=1, user=1, assistant=0, tool=0, first=user, last=user",
          );
          expect(errors[0]).toContain(
            `model=manual-model, toolDefinitions=0, userContent=[${diagnostic}]`,
          );
          expect(errors[0]).not.toContain(content);
        } finally {
          adapter.releaseRun?.();
        }
      }),
    ),
  );
  effectTest.effect(
    "uses the provider-normalized effort for chat when the stored effort is unsupported",
    () =>
      Effect.gen(function* () {
        const f = fixture(undefined, {
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "low",
          openaiCompatible: configuration,
        });
        const layer = ActiveProvider.layer.pipe(
          Layer.provide(ProviderRegistry.layer([f.api.services], [yield* f.api.runtime])),
          Layer.provide(Layer.succeed(GlobalConfig, f.config)),
        );
        const selection = yield* Effect.flatMap(ActiveProvider, (active) => active.selected).pipe(
          Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
            const services = yield* Layer.build(layer);
            return yield* Effect.provideContext(program, services);
          }, Effect.scoped),
        );
        expect(selection).toEqual({
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "default",
        });
        expect(f.saved().reasoningEffort).toBe("low");
        const adapter = (yield* f.api.runtime).adapter(selection!);
        yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
        adapter.releaseRun?.();
      }),
  );
  effectTest.live("ignores and clears cached capabilities from the removed LM Studio probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(
          nativeFetch((url) =>
            Effect.sync(() => {
              const address =
                url instanceof Request ? url.url : url instanceof URL ? url.href : url;
              expect(new URL(address).pathname).toBe("/v1/models");
              return Response.json({ data: [{ id: configuration.model }] });
            }),
          ),
          {
            provider: "openai-compatible",
            model: configuration.model,
            reasoningEffort: "xhigh",
            openaiCompatible: {
              ...configuration,
              reasoning: { source: "lm-studio", model: configuration.model, options: ["xhigh"] },
            },
          },
        );
        expect((yield* f.api.services.models.selected)?.reasoningEffort).toBe("default");
        const model = (yield* f.api.services.models.list)[0];
        expect(model?.supportedReasoningEfforts).toEqual(["default"]);
        expect(f.saved().openaiCompatible?.reasoning).toBeUndefined();
        expect(
          yield* Effect.flip(f.api.services.models.select(configuration.model, "xhigh")),
        ).toBeInstanceOf(Error);
      }),
    ),
  );
  effectTest.live("does not apply an old server's model metadata after an endpoint change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = Deferred.makeUnsafe<void>();
        const response = Deferred.makeUnsafe<Response>();
        const f = fixture(
          nativeFetch(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(response);
            }),
          ),
        );
        yield* f.api.update(configuration);
        const listing = yield* Effect.forkChild(f.api.listModels, { startImmediately: true });
        const rejected = yield* Effect.forkChild(Fiber.join(listing).pipe(Effect.result), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        yield* f.api.update({ ...configuration, baseUrl: "http://other.test/v1" });
        yield* Deferred.succeed(
          response,
          Response.json({
            data: [
              {
                id: configuration.model,
                capabilities: { reasoning: { allowed_options: ["high"] } },
              },
            ],
          }),
        );
        expect(Result.isFailure(yield* Fiber.join(rejected))).toBe(true);
        expect(f.saved().openaiCompatible?.reasoning).toBeUndefined();
      }),
    ),
  );
  effectTest.live(
    "uses explicit model-list capabilities before probing server-specific endpoints",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const paths: string[] = [];
          const f = fixture(
            nativeFetch((url) =>
              Effect.sync(() => {
                const address =
                  url instanceof Request ? url.url : url instanceof URL ? url.href : url;
                paths.push(new URL(address).pathname);
                return Response.json({
                  data: [
                    {
                      id: configuration.model,
                      capabilities: {
                        reasoning: {
                          allowed_options: ["low", "high", "unrecognized"],
                          default: "high",
                        },
                      },
                    },
                  ],
                });
              }),
            ),
          );
          yield* f.api.update(configuration);
          expect((yield* f.api.services.models.list)[0]?.supportedReasoningEfforts).toEqual([
            "default",
            "low",
            "high",
          ]);
          expect(f.saved().openaiCompatible?.reasoning?.source).toBe("models");
          expect(paths).toEqual(["/v1/models"]);
          yield* f.api.services.models.select(configuration.model, "high");
          expect(
            yield* Effect.flip(f.api.services.models.select(configuration.model, "none")),
          ).toBeInstanceOf(Error);
        }),
      ),
  );
  effectTest.effect("does not infer levels from a public supported-parameter list", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const f = fixture(
        nativeFetch((url) =>
          Effect.sync(() => {
            const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
            paths.push(new URL(address).pathname);
            return Response.json({
              data: [
                { id: configuration.model, supported_parameters: ["reasoning", "temperature"] },
              ],
            });
          }),
        ),
      );
      yield* f.api.update(configuration);
      const model = (yield* f.api.services.models.list)[0];
      expect(model?.capabilities.reasoning).toBe(true);
      expect(model?.supportedReasoningEfforts).toEqual(["default"]);
      expect(paths).toEqual(["/v1/models"]);
    }),
  );
  effectTest.effect.each(["vllm", "organization_owner", "unknown"])(
    "only reads /models for owner %s without capabilities",
    (owner) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const f = fixture(
          nativeFetch((url) =>
            Effect.sync(() => {
              const address =
                url instanceof Request ? url.url : url instanceof URL ? url.href : url;
              paths.push(new URL(address).pathname);
              return Response.json({ data: [{ id: configuration.model, owned_by: owner }] });
            }),
          ),
        );
        yield* f.api.update(configuration);
        expect((yield* f.api.services.models.list)[0]?.supportedReasoningEfforts).toEqual([
          "default",
        ]);
        expect(paths).toEqual(["/v1/models"]);
      }),
  );
  effectTest.effect("keeps model listing usable when extension fields are unsupported", () =>
    Effect.gen(function* () {
      const f = fixture(
        nativeFetch((url) =>
          Effect.sync(() => {
            const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
            expect(new URL(address).pathname).toBe("/v1/models");
            return Response.json({
              data: [
                {
                  id: configuration.model,
                  capabilities: { reasoning: true },
                  supported_parameters: null,
                },
              ],
            });
          }),
        ),
      );
      yield* f.api.update(configuration);
      expect(yield* f.api.listModels).toEqual([configuration.model]);
      expect((yield* f.api.services.models.list)[0]?.supportedReasoningEfforts).toEqual([
        "default",
      ]);
      expect(f.saved().openaiCompatible?.reasoning).toBeUndefined();
    }),
  );
  effectTest.effect(
    "keeps the legacy omitted effort as the server default when discovering none support",
    () =>
      Effect.gen(function* () {
        const f = fixture(
          nativeFetch(() =>
            Effect.sync(() =>
              Response.json({
                data: [
                  {
                    id: configuration.model,
                    capabilities: {
                      reasoning: { allowed_options: ["none", "low"], default: "low" },
                    },
                  },
                ],
              }),
            ),
          ),
          {
            provider: "openai-compatible",
            model: configuration.model,
            reasoningEffort: "none",
            openaiCompatible: configuration,
          },
        );
        yield* f.api.services.models.list;
        expect(f.saved().reasoningEffort).toBe("default");
        yield* f.api.services.models.select(configuration.model, "none");
        yield* f.api.services.models.list;
        expect(f.saved().reasoningEffort).toBe("none");
      }),
  );
  effectTest.live(
    "discovers model-specific reasoning levels, restores selection and sends only supported effort",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const Body = Schema.fromJsonString(
            Schema.Struct({ reasoning_effort: Schema.optional(Schema.String) }),
          );
          const bodies: (typeof Body.Type)[] = [];
          const f = fixture(
            nativeFetch((url, init) =>
              Effect.sync(() => {
                const address =
                  url instanceof Request ? url.url : url instanceof URL ? url.href : url;
                if (address.endsWith("/models"))
                  return Response.json({
                    data: [
                      {
                        id: configuration.model,
                        capabilities: {
                          reasoning: {
                            allowed_options: ["none", "low", "xhigh", "unknown"],
                            default: "xhigh",
                          },
                        },
                      },
                    ],
                  });
                bodies.push(
                  EffectFunction.flow(
                    Schema.decodeUnknownResult(Body),
                    Result.getOrThrow,
                  )(init?.body),
                );
                return new Response(
                  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"manual-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }),
            ),
          );
          yield* f.api.update(configuration);
          expect((yield* f.api.services.models.list)[0]?.supportedReasoningEfforts).toEqual([
            "default",
            "none",
            "low",
            "xhigh",
          ]);
          expect(
            yield* Effect.flip(f.api.services.models.select(configuration.model, "medium")),
          ).toBeInstanceOf(Error);
          for (const effort of ["xhigh", "default"]) {
            const selection = yield* f.api.services.models.select(configuration.model, effort);
            expect(yield* f.restore().services.models.selected).toEqual(selection);
            const adapter = (yield* f.api.runtime).adapter(selection);
            yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
            try {
              yield* Stream.runForEach(
                Stream.fromAsyncIterable(
                  adapter.chatStream({
                    logger: resolveDebugOption(false),
                    model: configuration.model,
                    messages: [{ role: "user", content: "hi" }],
                  }),
                  (cause) => new Cause.UnknownError(cause),
                ),
                (_chunk) =>
                  Effect.sync(() => {
                    /* consume */
                  }),
              );
            } finally {
              adapter.releaseRun?.();
            }
          }
          expect(bodies[0]?.reasoning_effort).toBe("xhigh");
          expect(bodies[1]).not.toHaveProperty("reasoning_effort");
          yield* f.api.services.models.select(configuration.model, "xhigh");
          yield* f.api.update(configuration);
          expect((yield* f.restore().services.models.selected)?.reasoningEffort).toBe("xhigh");
          yield* f.api.update({ ...configuration, model: "other-model" });
          expect((yield* f.restore().services.models.selected)?.reasoningEffort).toBe("default");
        }),
      ),
  );
  effectTest.live.each(["reasoning_content", "reasoning"])(
    "streams and restores %s separately from the final answer",
    (field) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sqlite = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(":memory:")),
            (sqlite) =>
              Effect.sync(() => {
                if (sqlite.isOpen) sqlite.close();
              }),
          );
          for (const step of migrations) sqlite.exec(step);
          const persistence = sqliteChatPersistence(sqlite);
          const f = fixture(
            nativeFetch(() =>
              Effect.sync(() => {
                const chunks = [
                  ...[{ [field]: "Compare the values." }, { content: "The answer is 42." }].map(
                    (delta) => ({
                      id: "reasoning-test",
                      object: "chat.completion.chunk",
                      created: 1,
                      model: configuration.model,
                      choices: [{ index: 0, delta, finish_reason: null }],
                    }),
                  ),
                  {
                    id: "reasoning-test",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: configuration.model,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  },
                ];
                return new Response(
                  chunks.map((chunk) => `data: ${jsonStringify(chunk)}\n\n`).join("") +
                    "data: [DONE]\n\n",
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }),
            ),
          );
          yield* f.api.update(configuration);
          const adapter = (yield* f.api.runtime).adapter({
            provider: "openai-compatible",
            model: configuration.model,
            reasoningEffort: "default",
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
          try {
            const events = yield* Stream.runCollect(
              Stream.fromAsyncIterable(
                chat({
                  adapter,
                  messages: [{ role: "user", content: "Answer the question." }],
                  threadId: "reasoning",
                  runId: "reasoning-run",
                  middleware: [withPersistence(persistence)],
                }),
                (cause) => new Cause.UnknownError(cause),
              ),
            );
            expect(events).toContainEqual(
              expect.objectContaining({
                type: "REASONING_MESSAGE_CONTENT",
                delta: "Compare the values.",
              }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "The answer is 42." }),
            );
            const response = yield* sdkCall(() =>
              reconstructChat(persistence, new Request("http://localhost/chat?threadId=reasoning")),
            );
            const restored = yield* sdkCall(() => response.json());
            expect(jsonStringify(restored)).toContain('"type":"thinking"');
            expect(jsonStringify(restored)).toContain("Compare the values.");
            expect(jsonStringify(restored)).toContain("The answer is 42.");
          } finally {
            adapter.releaseRun?.();
            sqlite.close();
          }
        }),
      ),
  );
  effectTest.effect("validates endpoint, limits, and never persists keys", () =>
    Effect.gen(function* () {
      const f = fixture();
      const status = yield* f.api.update({ ...configuration, apiKey: "test-only-key" });
      expect(status.hasApiKey).toBe(true);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(f.saved()),
      ).not.toContain("[redacted:credential]");
      yield* f.api.update(configuration);
      expect((yield* f.api.status).hasApiKey).toBe(true);
      const rejected = yield* Effect.flip(
        f.api.update({
          ...configuration,
          baseUrl: "http://127.0.0.1:9876/v1",
        }),
      );
      expect(rejected.operation).toBe("validation");
      yield* f.api.update({ ...configuration, apiKey: null });
      expect((yield* f.api.status).hasApiKey).toBe(false);
      for (const patch of [
        { baseUrl: "file:///tmp/server" },
        { baseUrl: "https://user:password@example.com/v1" },
        { contextWindow: 0 },
        { outputBudget: 8192 },
        { outputBudget: -1 },
      ])
        expect(() => validateCompatibleConfiguration({ ...configuration, ...patch })).toThrow();
    }),
  );
  effectTest.live("restores a manual model without discovery and isolates discovery errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(
          nativeFetch(() =>
            Effect.sync(() => new Response("private provider diagnostic", { status: 503 })),
          ),
        );
        yield* f.api.update(configuration);
        yield* f.api.services.models.select(configuration.model);
        expect(yield* f.restore().services.models.selected).toEqual({
          provider: "openai-compatible",
          model: "manual-model",
          reasoningEffort: "default",
        });
        expect(yield* Effect.flip(f.api.listModels)).toBeInstanceOf(Error);
        expect((yield* f.api.services.models.list)[0]?.id).toBe("manual-model");
        expect(yield* Effect.flip(f.api.services.models.select("missing"))).toBeInstanceOf(Error);
        expect((yield* f.api.runtime).contextWindow(configuration.model)).toBe(7680);
      }),
    ),
  );
  effectTest.live("interrupting discovery aborts the actual fetch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const f = fixture(
          stalledFetch((observed) => {
            signal = observed;
            void nativeEffect(Deferred.succeed(requested, undefined));
          }),
        );
        yield* f.api.update(configuration);
        const fiber = yield* Effect.forkChild(f.api.listModels, { startImmediately: true });
        yield* Deferred.await(requested);
        yield* Fiber.interrupt(fiber);
        expect(signal?.aborted).toBe(true);
      }),
    ),
  );
  effectTest.effect("times out discovery with a typed failure and aborts the request", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const f = fixture(
        stalledFetch((observed) => {
          signal = observed;
        }),
      );
      yield* f.api.update(configuration);
      const discovery = yield* Effect.forkChild(Effect.result(f.api.listModels), {
        startImmediately: true,
      });
      yield* TestClock.adjust("15 seconds");
      assertFailure(
        yield* Fiber.join(discovery),
        new OpenAICompatibleFailed({ operation: "models" }),
      );
      expect(signal?.aborted).toBe(true);
    }),
  );
  effectTest.effect("reports an uncertain keyring write as partial without writing settings", () =>
    Effect.gen(function* () {
      let saved: Settings = {};
      const api = makeOpenAICompatibleSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: {
          get: () => Promise.resolve(null),
          set: nativeWrite(() =>
            Effect.fail(new Cause.UnknownError(new Error("private keyring detail"))),
          ),
        },
      });
      const result = yield* Effect.flip(api.update({ ...configuration, apiKey: "secret" }));
      expect(result.operation).toBe("partial");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(saved),
      ).not.toContain("secret");
      expect(saved.openaiCompatible).toBeUndefined();
    }),
  );
  effectTest.effect(
    "reports config failure after a key write as partial without persisting a secret",
    () =>
      Effect.gen(function* () {
        let key: string | null = null;
        const api = makeOpenAICompatibleSettings({
          config: {
            read: Effect.succeed({}),
            update: () =>
              Effect.fail(
                GlobalConfigFailed.make({
                  operation: "write",
                  reason: { _tag: "WriteFailed" },
                  cause: new Error("private config detail"),
                }),
              ),
          },
          keys: {
            get: () => Promise.resolve(key),
            set: nativeWrite((value) =>
              Effect.sync(() => {
                key = value;
              }),
            ),
          },
        });
        const error = yield* Effect.flip(api.update({ ...configuration, apiKey: "secret" }));
        expect(error.operation).toBe("partial");
        expect(key).toContain("secret");
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error),
        ).not.toContain("secret");
      }),
  );
  effectTest.live(
    "never sends a new key to the old endpoint while settings update is in flight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let saved: Settings = {};
          let key: string | null = null;
          const writing = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
          const seen: Array<{ url: string; authorization: string | null }> = [];
          const api = makeOpenAICompatibleSettings({
            config: {
              read: Effect.sync(() => saved),
              update: (patch: Partial<Settings>) =>
                Effect.sync(() => (saved = { ...saved, ...patch })),
            },
            keys: {
              get: () => Promise.resolve(key),
              set: nativeWrite((value) =>
                Effect.gen(function* () {
                  if (value?.includes('"key":"second"') === true) {
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(gate);
                  }
                  key = value;
                }),
              ),
            },
            fetcher: nativeFetch((url, init) =>
              Effect.sync(() => {
                seen.push({
                  url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
                  authorization: new Headers(init?.headers).get("authorization"),
                });
                return Response.json({ choices: [{ message: { content: "OK" } }] });
              }),
            ),
          });
          yield* api.update({ ...configuration, apiKey: "first" });
          const pending = yield* Effect.forkChild(
            api.update({
              ...configuration,
              baseUrl: "http://127.0.0.1:9876/v1",
              apiKey: "second",
            }),
            { startImmediately: true },
          );
          yield* Deferred.await(writing);
          const probe = yield* Effect.forkChild(api.test, { startImmediately: true });
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(pending);
          yield* Fiber.join(probe);
          expect(seen).toEqual([
            {
              url: "http://127.0.0.1:9876/v1/chat/completions",
              authorization: "Bearer second",
            },
          ]);
        }),
      ),
  );
  effectTest.effect("keeps the old endpoint unauthenticated after an uncertain changed key", () =>
    Effect.gen(function* () {
      let saved: Settings = {};
      let key: string | null = null;
      let rejectWrite = false;
      const headers: Array<string | null> = [];
      const api = makeOpenAICompatibleSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: {
          get: () => Promise.resolve(key),
          set: nativeWrite((value) =>
            Effect.gen(function* () {
              key = value;
              if (rejectWrite)
                return yield* new Cause.UnknownError(new Error("uncertain keyring outcome"));
            }),
          ),
        },
        fetcher: nativeFetch((_url, init) =>
          Effect.sync(() => {
            headers.push(new Headers(init?.headers).get("authorization"));
            return Response.json({ choices: [{ message: { content: "OK" } }] });
          }),
        ),
      });
      yield* api.update({ ...configuration, apiKey: "first" });
      rejectWrite = true;
      const error = yield* Effect.flip(
        api.update({
          ...configuration,
          baseUrl: "http://127.0.0.1:9876/v1",
          apiKey: "second",
        }),
      );
      expect(error.operation).toBe("partial");
      // A stored key remains visible for explicit removal, but is not sent to the old URL.
      expect((yield* api.status).hasApiKey).toBe(true);
      yield* api.test;
      expect(headers).toEqual([null]);
    }),
  );
  effectTest.effect("updates an active model selection when its manual model ID changes", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.api.update(configuration);
      yield* f.api.services.models.select(configuration.model);
      yield* f.api.update({ ...configuration, model: "changed-manual-model" });
      expect(yield* f.api.services.models.selected).toEqual({
        provider: "openai-compatible",
        model: "changed-manual-model",
        reasoningEffort: "default",
      });
    }),
  );
  effectTest.live("serializes model selection with an in-flight settings update", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let saved: Settings = {};
        const writing = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const api = makeOpenAICompatibleSettings({
          config: {
            read: Effect.sync(() => saved),
            update: (patch: Partial<Settings>) =>
              Effect.sync(() => (saved = { ...saved, ...patch })),
          },
          keys: {
            get: () => Promise.resolve(null),
            set: nativeWrite(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(gate);
              }),
            ),
          },
        });
        yield* api.update(configuration);
        const changing = yield* Effect.forkChild(
          api.update({
            ...configuration,
            model: "new-model",
            apiKey: "key",
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(writing);
        const selection = yield* Effect.forkChild(
          Effect.flip(api.services.models.select(configuration.model)),
          { startImmediately: true },
        );
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(changing);
        expect((yield* Fiber.join(selection))._tag).toBe("ModelUnavailable");
        expect(yield* api.services.models.selected).toBeNull();
        expect((yield* api.services.models.list)[0]?.id).toBe("new-model");
      }),
    ),
  );
  effectTest.live("releases a run even when the keyring read never settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const neverRead = yield* Effect.forkChild(Effect.never, { startImmediately: true });
        let saved: Settings = { openaiCompatible: configuration };
        const api = makeOpenAICompatibleSettings({
          config: {
            read: Effect.sync(() => saved),
            update: (patch: Partial<Settings>) =>
              Effect.sync(() => (saved = { ...saved, ...patch })),
          },
          keys: {
            get: () => nativeEffect(Fiber.join(neverRead)),
            set: nativeWrite(() => Effect.sync(() => {})),
          },
          fetcher: nativeFetch(() =>
            Effect.fail(new Cause.UnknownError(new Error("must not reach network"))),
          ),
        });
        const adapter = (yield* api.runtime).adapter({
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "default",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
        const consumed = yield* Effect.forkChild(
          Stream.runForEach(
            Stream.fromAsyncIterable(
              adapter.chatStream({
                logger: resolveDebugOption(false),
                model: configuration.model,
                messages: [{ role: "user", content: "hi" }],
              }),
              (cause) => new Cause.UnknownError(cause),
            ),
            (_chunk) =>
              Effect.sync(() => {
                /* drain */
              }),
          ),
          { startImmediately: true },
        );
        adapter.releaseRun?.();
        expect(yield* Fiber.join(consumed).pipe(Effect.timeout("1 second"))).toBeUndefined();
      }),
    ),
  );
  effectTest.live("releaseRun aborts an in-flight compatible SDK request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        let signal: AbortSignal | undefined;
        const f = fixture(
          stalledFetch((observed) => {
            signal = observed;
            void nativeEffect(Deferred.succeed(requested, undefined));
          }),
        );
        yield* f.api.update(configuration);
        const adapter = (yield* f.api.runtime).adapter({
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "default",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
        const iterator = adapter
          .chatStream({
            logger: resolveDebugOption(false),
            model: configuration.model,
            messages: [{ role: "user", content: "hi" }],
          })
          [Symbol.asyncIterator]();
        const result = iterator.next();
        yield* Deferred.await(requested);
        adapter.releaseRun?.();
        expect(signal?.aborted).toBe(true);
        yield* sdkCall(() => result);
        yield* sdkCall(() => iterator.return?.());
      }),
    ),
  );
  effectTest.live(
    "pins endpoint, model, key, and budget to an adapter across later settings edits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let saved: Settings = {};
          let key: string | null = null;
          const observed: Array<{ url: string; authorization: string | null; body: string }> = [];
          const api = makeOpenAICompatibleSettings({
            config: {
              read: Effect.sync(() => saved),
              update: (patch: Partial<Settings>) =>
                Effect.sync(() => (saved = { ...saved, ...patch })),
            },
            keys: {
              get: () => Promise.resolve(key),
              set: nativeWrite((value) =>
                Effect.sync(() => {
                  key = value;
                }),
              ),
            },
            fetcher: nativeFetch((url, init) =>
              Effect.sync(() => {
                observed.push({
                  url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
                  authorization: new Headers(init?.headers).get("authorization"),
                  body: EffectFunction.flow(
                    Schema.decodeUnknownResult(Schema.String),
                    Result.getOrThrow,
                  )(init?.body ?? "{}"),
                });
                return new Response(
                  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"manual-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }),
            ),
          });
          yield* api.update({ ...configuration, apiKey: "first" });
          const adapter = (yield* api.runtime).adapter({
            provider: "openai-compatible",
            model: configuration.model,
            reasoningEffort: "default",
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
          yield* api.update({
            ...configuration,
            baseUrl: "http://127.0.0.1:9876/v1",
            outputBudget: 128,
            apiKey: "second",
          });
          yield* Stream.runForEach(
            Stream.fromAsyncIterable(
              adapter.chatStream({
                logger: resolveDebugOption(false),
                model: configuration.model,
                messages: [{ role: "user", content: "hi" }],
              }),
              (cause) => new Cause.UnknownError(cause),
            ),
            (_chunk) =>
              Effect.sync(() => {
                /* consume */
              }),
          );
          adapter.releaseRun?.();
          expect(observed).toHaveLength(1);
          expect(observed[0]?.url).toContain("127.0.0.1:1234/v1/chat/completions");
          expect(observed[0]?.authorization).toBe("Bearer first");
          expect(
            (yield* Schema.decodeEffect(
              Schema.fromJsonString(Schema.Struct({ max_tokens: Schema.Int })),
            )(observed[0]?.body ?? "{}")).max_tokens,
          ).toBe(512);
        }),
      ),
  );
  effectTest.live(
    "uses Chat Completions streaming with tools and an explicit output budget; off removes tools",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: Array<{
            path: string;
            authorization: string | undefined;
            body: typeof ChatRequest.Type;
          }> = [];
          const { url } = yield* testHttpServer(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const body = yield* request.text;
              requests.push({
                path: request.url,
                authorization: request.headers.authorization,
                body: yield* Schema.decodeEffect(Schema.fromJsonString(ChatRequest))(
                  body === "" ? "{}" : body,
                ),
              });
              if (request.url === "/v1/models")
                return yield* HttpServerResponse.json({ data: [{ id: "discovered" }] });
              const toolsEnabled = requests.at(-1)?.body.tools !== undefined;
              const deltas = toolsEnabled
                ? [
                    {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_lookup",
                          type: "function",
                          function: { name: "lookup", arguments: "{" },
                        },
                      ],
                    },
                    { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
                  ]
                : [{ role: "assistant", content: "OK" }];
              const chunks = [
                ...deltas.map((delta) => ({ delta, finish_reason: null })),
                {
                  delta: {},
                  finish_reason: toolsEnabled ? "tool_calls" : "stop",
                },
              ];
              return HttpServerResponse.text(
                chunks
                  .map(
                    (chunk) =>
                      `data: ${jsonStringify({
                        id: "test",
                        object: "chat.completion.chunk",
                        created: 1,
                        model: "manual-model",
                        choices: [{ index: 0, ...chunk }],
                      })}\n\n`,
                  )
                  .join("") + "data: [DONE]\n\n",
                { contentType: "text/event-stream" },
              );
            }),
          );
          {
            const f = fixture();
            const settings = { ...configuration, baseUrl: `${url}/v1` };
            yield* f.api.update(settings);
            expect(yield* f.api.listModels).toEqual(["discovered"]);
            const selection = yield* f.api.services.models.select(configuration.model);
            const tool = {
              name: "lookup",
              description: "Lookup",
              inputSchema: { type: "object", properties: {} },
            };
            const consume = () =>
              Effect.gen(function* () {
                const chunks = yield* Stream.runCollect(
                  Stream.fromAsyncIterable(
                    (yield* f.api.runtime).adapter(selection).chatStream({
                      logger: resolveDebugOption(false),
                      model: configuration.model,
                      messages: [{ role: "user", content: "hello" }],
                      tools: [tool],
                    }),
                    (cause) => new Cause.UnknownError(cause),
                  ),
                );
                return chunks;
              });
            const toolChunks = yield* consume();
            expect(toolChunks).toContainEqual(
              expect.objectContaining({
                type: "TOOL_CALL_START",
                toolCallId: "call_lookup",
                toolCallName: "lookup",
              }),
            );
            expect(toolChunks).toContainEqual(
              expect.objectContaining({ type: "TOOL_CALL_END", toolCallId: "call_lookup" }),
            );
            expect(toolChunks).toContainEqual(
              expect.objectContaining({ type: "RUN_FINISHED", finishReason: "tool_calls" }),
            );
            expect(requests.at(-1)?.path).toBe("/v1/chat/completions");
            expect(requests.at(-1)?.body.max_tokens).toBe(512);
            expect(requests.at(-1)?.body.tools).toBeDefined();
            expect(requests.at(-1)?.authorization).toBeUndefined();
            yield* f.api.update({ ...settings, toolCalling: false });
            yield* consume();
            expect(requests.at(-1)?.body.tools).toBeUndefined();
            const adapter = (yield* f.api.runtime).adapter(selection);
            yield* Effect.addFinalizer(() => Effect.sync(() => adapter.releaseRun?.()));
            const before = requests.length;

            const chunks = yield* Stream.runCollect(
              Stream.fromAsyncIterable(
                adapter.chatStream({
                  logger: resolveDebugOption(false),
                  model: configuration.model,
                  messages: [{ role: "user", content: "x".repeat(100_000) }],
                }),
                (cause) => new Cause.UnknownError(cause),
              ),
            );
            expect(chunks.some((chunk) => chunk.type === "RUN_ERROR")).toBe(true);
            expect(requests.length).toBe(before);
          }
        }),
      ),
  );
});
