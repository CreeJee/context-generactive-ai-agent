import {
  GlobalConfigFailed,
  GlobalConfigFailedReason,
  type GlobalConfigApi,
} from "../src/config/global-config.ts";
import {
  compatibleAccountsOf,
  LEGACY_COMPATIBLE_ACCOUNT_ID,
  LEGACY_COMPATIBLE_CREDENTIAL_ENTRY,
  compatibleEndpointModel,
  selectedCompatibleAccount,
  type OpenAICompatibleConfiguration,
  type OpenAICompatibleStatus,
} from "../src/providers/openai-compatible-config.ts";
import { it as effectTest } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { TestClock } from "effect/testing";
import { Result, Function as EffectFunction } from "effect";
// Native SDK fetch, keyring and AsyncGenerator adapters remain explicit Promise boundaries.
import { testHttpServer, HttpServerRequest, HttpServerResponse } from "./support/http.ts";
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { GlobalConfig } from "../src/config/global-config.ts";
import { ActiveProvider } from "../src/providers/active-provider.ts";
import { ModelUnavailable } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { describe, expect } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import {
  makeOpenAICompatibleSettings,
  type CompatibleKeyStore,
  OpenAICompatibleFailed,
  validateCompatibleConnection,
  validateCompatibleModel,
} from "../src/providers/openai-compatible.ts";

type SingleEndpointUpdate = Omit<OpenAICompatibleConfiguration, "reasoning"> & {
  readonly apiKey?: string | null;
};
/**
 * The endpoint-with-one-model surface these cases were written for, driven through the first
 * registered account and its catalog.
 */
function singleEndpointSettings(options: {
  readonly config: GlobalConfigApi;
  readonly keys: CompatibleKeyStore;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const api = makeOpenAICompatibleSettings({
    config: options.config,
    keys: () => options.keys,
    fetcher: options.fetcher,
  });
  // Read from the config so locating the endpoint never touches a gated keychain.
  const first = Effect.map(
    options.config.read,
    (settings) => compatibleAccountsOf(settings).accounts[0] ?? null,
  );
  const single = (status: OpenAICompatibleStatus) => {
    const account = status.accounts[0];
    const model = account?.models[0];
    return {
      configuration:
        account === undefined || model === undefined
          ? null
          : compatibleEndpointModel({ ...account, credentialEntry: "unused" }, model.id),
      hasApiKey: account?.hasApiKey ?? false,
    };
  };
  const update = ({ apiKey, model, baseUrl, ...limits }: SingleEndpointUpdate) =>
    Effect.gen(function* () {
      const existing = yield* first;
      const connection = { baseUrl, ...(apiKey !== undefined && { apiKey }) };
      const id =
        existing === null
          ? ((yield* api.create(connection)).accounts.at(-1)?.id ?? "")
          : existing.id;
      if (existing !== null) yield* api.connect(id, connection);
      yield* api.saveModel(id, { id: model, ...limits });
      for (const other of existing?.models ?? [])
        if (other.id !== model) yield* api.removeModel(id, other.id);
      return single(yield* api.status);
    });
  return {
    ...api,
    status: Effect.map(api.status, single),
    update,
    test: Effect.flatMap(first, (account) =>
      api.test(account?.id ?? "", account?.models[0]?.id ?? ""),
    ),
    listModels: Effect.flatMap(first, (account) => api.discover(account?.id ?? "")),
  };
}
const endpointOf = (settings: Settings) => {
  const account = selectedCompatibleAccount(compatibleAccountsOf(settings));
  const model = account?.models[0];
  return account === null || model === undefined
    ? undefined
    : (compatibleEndpointModel(account, model.id) ?? undefined);
};
const validateCompatibleConfiguration = ({ baseUrl, model, ...limits }: SingleEndpointUpdate) =>
  Effect.all([
    validateCompatibleConnection({ baseUrl }),
    validateCompatibleModel({ id: model, ...limits }),
  ]);

/** Native fetch fixture: interruption comes from the Effect running model discovery. */
const stalledFetch =
  (observe: (signal: AbortSignal | undefined) => void): typeof fetch =>
  (_url, init) => {
    const signal = init?.signal ?? undefined;
    observe(signal);
    return Effect.runPromise(Effect.never, { signal });
  };

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
/** The body a fetch fixture was given; the model's client sends bytes, not a string. */
const requestText = (init: RequestInit | undefined) =>
  Effect.tryPromise(() => new Response(init?.body).text());
// Wire fixtures encode synchronously at the SDK boundary; Effect assertions use typed decoders.
const jsonStringify = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

/** The run every model here is made for. */
const run = { threadId: "thread", runId: "run", cacheRetention: "none" } as const;

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
    get: Effect.sync(() => key),
    set: (value: string | null) =>
      Effect.sync(() => {
        key = value;
      }),
  };
  return {
    config,
    api: singleEndpointSettings({ config: config, keys: keys, fetcher: fetcher }),
    restore: () => singleEndpointSettings({ config: config, keys: keys, fetcher: fetcher }),
    saved: () => saved,
  };
}
describe("OpenAI compatible settings", () => {
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
        yield* Effect.scoped((yield* f.api.runtime).model(selection!, run));
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
        expect(endpointOf(f.saved())?.reasoning).toBeUndefined();
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
        expect(endpointOf(f.saved())?.reasoning).toBeUndefined();
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
          expect(endpointOf(f.saved())?.reasoning?.source).toBe("models");
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
  effectTest.effect("offers the levels Strata's own source accepts when /models names it", () =>
    Effect.gen(function* () {
      const f = fixture(
        nativeFetch(() =>
          Effect.sync(() =>
            Response.json({
              data: [
                { id: configuration.model, owned_by: "strata", meta: { label: "Qwen", gpus: [] } },
              ],
            }),
          ),
        ),
      );
      yield* f.api.update(configuration);
      expect((yield* f.api.services.models.list)[0]?.supportedReasoningEfforts).toEqual([
        "default",
        "none",
        "low",
        "medium",
        "high",
      ]);
      yield* f.api.services.models.select(configuration.model, "none");
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
      expect(endpointOf(f.saved())?.reasoning).toBeUndefined();
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
              Effect.map(requestText(init), (body) => {
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
                  EffectFunction.flow(Schema.decodeUnknownResult(Body), Result.getOrThrow)(body),
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
            yield* Effect.scoped(
              Effect.flatMap((yield* f.api.runtime).model(selection, run), ({ model }) =>
                model.generateText({ prompt: "hi" }),
              ),
            );
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
        expect(
          (yield* Effect.flip(validateCompatibleConfiguration({ ...configuration, ...patch })))
            .operation,
        ).toBe("validation");
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
        OpenAICompatibleFailed.make({ operation: "models" }),
      );
      expect(signal?.aborted).toBe(true);
    }),
  );
  effectTest.effect("reports an uncertain keyring write as partial without writing settings", () =>
    Effect.gen(function* () {
      let saved: Settings = {};
      const api = singleEndpointSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: {
          get: Effect.succeed(null),
          set: () => Effect.fail(new Cause.UnknownError(new Error("private keyring detail"))),
        },
      });
      const result = yield* Effect.flip(api.update({ ...configuration, apiKey: "secret" }));
      expect(result.operation).toBe("partial");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(saved),
      ).not.toContain("secret");
      expect(endpointOf(saved)).toBeUndefined();
    }),
  );
  effectTest.effect(
    "reports config failure after a key write as partial without persisting a secret",
    () =>
      Effect.gen(function* () {
        let key: string | null = null;
        const api = singleEndpointSettings({
          config: {
            read: Effect.succeed({}),
            update: () =>
              Effect.fail(
                GlobalConfigFailed.make({
                  operation: "write",
                  reason: GlobalConfigFailedReason.cases.WriteFailed.make({}),
                  cause: new Error("private config detail"),
                }),
              ),
          },
          keys: {
            get: Effect.sync(() => key),
            set: (value) =>
              Effect.sync(() => {
                key = value;
              }),
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
          const api = singleEndpointSettings({
            config: {
              read: Effect.sync(() => saved),
              update: (patch: Partial<Settings>) =>
                Effect.sync(() => (saved = { ...saved, ...patch })),
            },
            keys: {
              get: Effect.sync(() => key),
              set: (value) =>
                Effect.gen(function* () {
                  if (value?.includes('"key":"second"') === true) {
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(gate);
                  }
                  key = value;
                }),
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
      const api = singleEndpointSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: {
          get: Effect.sync(() => key),
          set: (value) =>
            Effect.gen(function* () {
              key = value;
              if (rejectWrite)
                return yield* new Cause.UnknownError(new Error("uncertain keyring outcome"));
            }),
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
        const api = singleEndpointSettings({
          config: {
            read: Effect.sync(() => saved),
            update: (patch: Partial<Settings>) =>
              Effect.sync(() => (saved = { ...saved, ...patch })),
          },
          keys: {
            get: Effect.succeed(null),
            set: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(gate);
              }),
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
        expect(yield* Fiber.join(selection)).toBeInstanceOf(ModelUnavailable);
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
        const api = singleEndpointSettings({
          config: {
            read: Effect.sync(() => saved),
            update: (patch: Partial<Settings>) =>
              Effect.sync(() => (saved = { ...saved, ...patch })),
          },
          keys: { get: Fiber.join(neverRead), set: () => Effect.void },
          fetcher: nativeFetch(() =>
            Effect.fail(new Cause.UnknownError(new Error("must not reach network"))),
          ),
        });
        const runtime = yield* api.runtime;
        const making = yield* Effect.forkChild(
          Effect.scoped(
            runtime.model(
              {
                provider: "openai-compatible",
                model: configuration.model,
                reasoningEffort: "default",
              },
              run,
            ),
          ),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(making).pipe(Effect.timeout("1 second"));
      }),
    ),
  );
  effectTest.live(
    "pins endpoint, model, key, and budget to a run's model across later settings edits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let saved: Settings = {};
          let key: string | null = null;
          const observed: Array<{ url: string; authorization: string | null; body: string }> = [];
          const api = singleEndpointSettings({
            config: {
              read: Effect.sync(() => saved),
              update: (patch: Partial<Settings>) =>
                Effect.sync(() => (saved = { ...saved, ...patch })),
            },
            keys: {
              get: Effect.sync(() => key),
              set: (value) =>
                Effect.sync(() => {
                  key = value;
                }),
            },
            fetcher: nativeFetch((url, init) =>
              Effect.map(requestText(init), (body) => {
                observed.push({
                  url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
                  authorization: new Headers(init?.headers).get("authorization"),
                  body,
                });
                return new Response(
                  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"manual-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "Content-Type": "text/event-stream" } },
                );
              }),
            ),
          });
          yield* api.update({ ...configuration, apiKey: "first" });
          const { model } = yield* (yield* api.runtime).model(
            {
              provider: "openai-compatible",
              model: configuration.model,
              reasoningEffort: "default",
            },
            run,
          );
          yield* api.update({
            ...configuration,
            baseUrl: "http://127.0.0.1:9876/v1",
            outputBudget: 128,
            apiKey: "second",
          });
          yield* model.generateText({ prompt: "hi" });
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
            const toolkit = Toolkit.make(
              Tool.dynamic("lookup", {
                description: "Lookup",
                parameters: {
                  type: "object",
                  properties: { glob: { type: "string" } },
                  additionalProperties: false,
                },
              }),
            );
            // The parts of a run's model, with tool calls left for the caller as the loop leaves them.
            const consume = (prompt: string) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const { model } = yield* (yield* f.api.runtime).model(selection, run);
                  return yield* Stream.runCollect(
                    model.streamText({
                      prompt,
                      toolkit,
                      disableToolCallResolution: true,
                      toolCallValidation: "deferred",
                    }),
                  );
                }),
              );
            const toolParts = yield* consume("hello");
            expect(toolParts).toContainEqual(
              expect.objectContaining({ type: "tool-call", id: "call_lookup", name: "lookup" }),
            );
            expect(toolParts).toContainEqual(
              expect.objectContaining({ type: "finish", reason: "tool-calls" }),
            );
            expect(requests.at(-1)?.path).toBe("/v1/chat/completions");
            expect(requests.at(-1)?.body.max_tokens).toBe(512);
            // A strict-capable schema still goes as written: strict would make `glob` required.
            expect(requests.at(-1)?.body.tools).toEqual([
              {
                type: "function",
                function: expect.objectContaining({
                  name: "lookup",
                  strict: false,
                  parameters: expect.objectContaining({
                    properties: { glob: { type: "string" } },
                    additionalProperties: false,
                  }),
                }),
              },
            ]);
            expect(requests.at(-1)?.authorization).toBeUndefined();
            yield* f.api.update({ ...settings, toolCalling: false });
            yield* consume("hello");
            expect(requests.at(-1)?.body.tools).toBeUndefined();
            // No output limit: the server's own limit applies and no input room is reserved.
            yield* f.api.update({ ...settings, toolCalling: false, outputBudget: null });
            yield* consume("hello");
            expect(requests.at(-1)?.body.max_tokens).toBeUndefined();
            expect((yield* f.api.runtime).contextWindow(configuration.model)).toBe(
              configuration.contextWindow,
            );
            const before = requests.length;
            yield* Effect.flip(consume("x".repeat(100_000)));
            expect(requests.length).toBe(before);
          }
        }),
      ),
  );

  effectTest.live(
    "keeps each endpoint's key apart and moves the model choice with the selected endpoint",
    () =>
      Effect.gen(function* () {
        let saved: Settings = {
          provider: "openai-compatible",
          model: configuration.model,
          reasoningEffort: "default",
          openaiCompatible: configuration,
        };
        const stored = new Map<string, string>([
          [LEGACY_COMPATIBLE_CREDENTIAL_ENTRY, "legacy-key-from-before-accounts"],
        ]);
        const api = makeOpenAICompatibleSettings({
          config: {
            read: Effect.sync(() => saved),
            update: (patch: Partial<Settings>) =>
              Effect.sync(() => (saved = { ...saved, ...patch })),
          },
          keys: (entry) => ({
            get: Effect.sync(() => stored.get(entry) ?? null),
            set: (value) =>
              Effect.sync(
                () => void (value === null ? stored.delete(entry) : stored.set(entry, value)),
              ),
          }),
        });
        const legacy = (yield* api.status).accounts;
        expect(legacy).toMatchObject([
          {
            id: LEGACY_COMPATIBLE_ACCOUNT_ID,
            baseUrl: configuration.baseUrl,
            models: [{ id: configuration.model }],
            hasApiKey: true,
            selected: true,
          },
        ]);

        const created = (yield* api.create({
          baseUrl: "https://second.test/v1",
          label: "Second",
          apiKey: "second-key",
        })).accounts;
        const id = created.find((account) => account.label === "Second")?.id ?? "";
        expect(created.find((account) => account.id === id)).toMatchObject({
          hasApiKey: true,
          selected: false,
          models: [],
        });
        expect(saved.openaiCompatible).toBeUndefined();
        expect(stored.get(LEGACY_COMPATIBLE_CREDENTIAL_ENTRY)).toBe(
          "legacy-key-from-before-accounts",
        );
        expect(stored.size).toBe(2);

        const second = {
          id: "second",
          contextWindow: 16384,
          outputBudget: 1024,
          toolCalling: false,
        };
        yield* api.saveModel(id, second);
        yield* api.saveModel(id, { ...second, id: configuration.model });
        // The same model registered on both endpoints stays chosen across a switch.
        yield* api.select(id);
        expect(saved).toMatchObject({ model: configuration.model });
        yield* api.removeModel(id, configuration.model);
        expect(saved).toMatchObject({ provider: "openai-compatible", model: "second" });
        const runtime = yield* api.runtime;
        expect(runtime.contextWindow("second")).toBe(second.contextWindow - second.outputBudget);
        expect(runtime.contextWindow(configuration.model)).toBe(0);

        yield* api.remove(id);
        expect(stored.size).toBe(1);
        expect(saved).toMatchObject({ model: configuration.model });
        expect((yield* api.status).accounts).toMatchObject([
          { id: LEGACY_COMPATIBLE_ACCOUNT_ID, selected: true },
        ]);
        const missing = yield* Effect.flip(api.select("missing"));
        expect(missing).toBeInstanceOf(OpenAICompatibleFailed);
        expect(missing).toMatchObject({ operation: "missing" });
      }),
  );
});
