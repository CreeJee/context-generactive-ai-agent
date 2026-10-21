import { runNativeEffectWith } from "../src/runtime/native-effect.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { it as effectTest } from "@effect/vitest";
import { Stream, DateTime, Deferred, Effect, Exit, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, test } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import {
  OAuthHarnessError,
  type LoginAttempt,
  type OAuthConnectionStatus,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { ModelUnavailable } from "../src/providers/contracts.ts";
import {
  createSubscriptionProvider,
  parseSubscriptionCatalog,
} from "../src/providers/subscription-provider.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";

// Native SDK callbacks receive a stable Promise backed by a Deferred owned by this test Scope.
const sdkGateFactory = Effect.fn("subscriptionProviderTest.sdkGateFactory")(function* () {
  const scope = yield* Effect.scope;
  const run = runNativeEffectWith(yield* Effect.context());
  return <A, E = never>() => {
    const deferred = Deferred.makeUnsafe<A, E>();
    let promise: Promise<A> | undefined;
    return {
      get promise() {
        if (promise === undefined)
          promise = run(
            Deferred.await(deferred).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
          );
        return promise;
      },
      release: (value: A) => Deferred.doneUnsafe(deferred, Effect.succeed(value)),
      reject: (error: E) => Deferred.doneUnsafe(deferred, Effect.fail(error)),
    };
  };
});
const settingsStore = () => {
  let settings: Settings = {};
  return {
    get value() {
      return settings;
    },
    read: Effect.sync(() => settings),
    update: (patch: Partial<Settings>) =>
      Effect.sync(() => {
        settings = { ...settings, ...patch };
        return settings;
      }),
  };
};

const fakeClient = Effect.fn("subscriptionProviderTest.fakeClient")(function* (
  provider: "openai" | "anthropic",
  pages: ReadonlyArray<unknown>,
) {
  let connected = false;
  let cancelled = false;
  let catalogRequests = 0;
  const makeGate = yield* sdkGateFactory();
  const completion = makeGate<OAuthConnectionStatus>();
  const attempt: LoginAttempt = {
    provider,
    authorizationUrl: `https://example.test/${provider}/authorize`,
    get completed() {
      return completion.promise;
    },
    cancel: () => {
      cancelled = true;
    },
  };
  return {
    client: {
      status: () => Promise.resolve({ provider, connected, expiresAt: null }),
      startLogin: () => Promise.resolve(attempt),
      disconnect: () =>
        Promise.resolve().then(() => {
          connected = false;
          return { provider, connected, expiresAt: null };
        }),
      modelCatalog: () =>
        Promise.resolve().then(() => {
          catalogRequests += 1;
          return pages;
        }),
      stream() {
        return nativeStream(Stream.fromIterable((function* () {})(), { chunkSize: 1 }));
      },
    },
    complete: () => {
      connected = true;
      completion.release({
        provider,
        connected: true,
        expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
      });
    },
    get cancelled() {
      return cancelled;
    },
    get catalogRequests() {
      return catalogRequests;
    },
  };
});

const catalogPages = (id: string, window = 400_000) => [
  { models: [{ slug: id, context_window: window }] },
];
const gatedCatalog = Effect.fn("subscriptionProviderTest.gatedCatalog")(function* () {
  const makeGate = yield* sdkGateFactory();
  const gates: {
    promise: Promise<ReadonlyArray<unknown>>;
    release: (pages: ReadonlyArray<unknown>) => boolean;
    reject: () => boolean;
  }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let key = "profile-a";
  const fake = yield* fakeClient("openai", []);
  const provider = createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config: settingsStore(),
    catalogKey: () => key,
    client: {
      ...fake.client,
      modelCatalog: (signal) => {
        signals.push(signal);
        const completion = makeGate<ReadonlyArray<unknown>, OAuthHarnessError>();
        const gate = {
          get promise() {
            return completion.promise;
          },
          release: completion.release,
          reject: () =>
            completion.reject(OAuthHarnessError.fromCode("transport_unavailable", null)),
        };
        gates.push(gate);
        return gate.promise;
      },
    },
  });
  return {
    provider,
    gates,
    signals,
    changeProfile: (next: string) => {
      key = next;
    },
  };
});

describe("subscription catalog concurrency", () => {
  effectTest.effect("retains success until the 30-second TTL expires", () =>
    Effect.gen(function* () {
      const { provider, gates } = yield* gatedCatalog();
      const first = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      gates[0]!.release(catalogPages("first"));
      yield* Fiber.join(first);
      yield* TestClock.adjust("29 seconds");
      expect((yield* provider.models.list)[0]?.id).toBe("first");
      expect(gates).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      const fresh = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      gates[1]!.release(catalogPages("fresh"));
      expect((yield* Fiber.join(fresh))[0]?.id).toBe("fresh");
    }),
  );

  effectTest.live(
    "coalesces eight concurrent cold calls into one invocation and retains success",
    () =>
      Effect.gen(function* () {
        const { provider, gates } = yield* gatedCatalog();
        const callers = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          Effect.forkChild(provider.models.list, { startImmediately: true }),
        );
        expect(gates).toHaveLength(1);
        gates[0]!.release(catalogPages("shared"));
        const results = yield* Effect.forEach(callers, (fiber) => Fiber.join(fiber));
        expect(results.every((models) => models[0]?.id === "shared")).toBe(true);
        expect((yield* provider.models.list)[0]?.id).toBe("shared");
        expect(gates).toHaveLength(1);
      }),
  );

  effectTest.live("shares a failure without retaining it for the next call", () =>
    Effect.gen(function* () {
      const { provider, gates } = yield* gatedCatalog();
      const owner = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      const waiter = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(1);
      gates[0]!.reject();
      for (const fiber of [owner, waiter]) {
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
      }
      const retry = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      gates[1]!.release(catalogPages("retry"));
      expect((yield* Fiber.join(retry))[0]?.id).toBe("retry");
    }),
  );

  effectTest.live("isolates changed profiles from a prior load and its late publication", () =>
    Effect.gen(function* () {
      const { provider, gates, changeProfile } = yield* gatedCatalog();
      const old = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      changeProfile("profile-b");
      const current = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      gates[1]!.release(catalogPages("current", 300_000));
      yield* Fiber.join(current);
      gates[0]!.release(catalogPages("old"));
      yield* Fiber.join(old);
      expect(provider.contextWindow("current")).toBe(300_000);
      expect(provider.contextWindow("old")).toBeNull();
      expect((yield* provider.models.list)[0]?.id).toBe("current");
      expect(gates).toHaveLength(2);
    }),
  );

  effectTest.live("disconnect prevents an already-running load from refilling the catalog", () =>
    Effect.gen(function* () {
      const { provider, gates } = yield* gatedCatalog();
      const old = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      yield* provider.auth.disconnect;
      gates[0]!.release(catalogPages("old"));
      yield* Fiber.join(old);
      expect(provider.contextWindow("old")).toBeNull();
      const fresh = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      gates[1]!.release(catalogPages("fresh"));
      expect((yield* Fiber.join(fresh))[0]?.id).toBe("fresh");
    }),
  );

  effectTest.live(
    "cancelling a shared waiter leaves its owner alive; owner interruption permits retry",
    () =>
      Effect.gen(function* () {
        const { provider, gates, signals } = yield* gatedCatalog();
        const owner = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        const waiter = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        const remaining = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        yield* Fiber.interrupt(waiter);
        expect(signals[0]?.aborted).toBe(false);
        expect(gates).toHaveLength(1);
        gates[0]!.release(catalogPages("shared"));
        for (const fiber of [owner, remaining]) {
          expect((yield* Fiber.join(fiber))[0]?.id).toBe("shared");
        }
        yield* provider.auth.disconnect;
        const interruptedOwner = yield* Effect.forkChild(provider.models.list, {
          startImmediately: true,
        });
        const interruptedWaiter = yield* Effect.forkChild(provider.models.list, {
          startImmediately: true,
        });
        yield* Fiber.interrupt(interruptedOwner);
        expect(signals[1]?.aborted).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(interruptedWaiter))).toBe(true);
        gates[1]!.release(catalogPages("interrupted"));
        const retry = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        expect(gates).toHaveLength(3);
        gates[2]!.release(catalogPages("retry"));
        yield* Fiber.join(retry);
        expect(provider.contextWindow("interrupted")).toBeNull();
        expect(provider.contextWindow("retry")).toBe(400_000);
      }),
  );
});

describe("subscription provider product services", () => {
  test("parses OpenAI catalog metadata without exposing transport fields", () => {
    const models = parseSubscriptionCatalog("openai", [
      {
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            default_reasoning_level: "high",
            supported_reasoning_levels: ["low", { reasoning_effort: "high" }, { value: "xhigh" }],
            input_modalities: ["text", "image"],
            context_window: 400_000,
          },
        ],
      },
    ]);

    expect(models).toEqual([
      {
        provider: "openai",
        id: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high", "xhigh"],
        contextWindow: 400_000,
        capabilities: {
          inputModalities: ["text", "image"],
          toolCalling: true,
          reasoning: true,
        },
      },
    ]);
    expect(JSON.stringify(models)).not.toContain("context_window");
    expect(JSON.stringify(models)).not.toContain("Authorization");
  });

  effectTest.effect(
    "uses each model's catalog window and labels an unknown window as a fallback",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeClient("openai", [
          {
            models: [
              { slug: "gpt-6-sol", context_window: 400_000 },
              { slug: "gpt-6-astra", context_window: 300_000 },
              { slug: "unknown-window", context_window: -1 },
            ],
          },
        ]);
        const provider = createSubscriptionProvider({
          protocol: providerProtocols.openai,
          config: settingsStore(),
          client: fake.client,
        });
        const runtime = createSubscriptionRuntime("openai", fake.client, provider.contextWindow);
        expect(runtime.contextWindowKnown?.("gpt-6-sol")).toBe(false);
        expect(runtime.contextWindow("gpt-6-sol")).toBe(258_400);
        yield* provider.models.list;
        expect(runtime.contextWindow("gpt-6-sol")).toBe(400_000);
        expect(runtime.contextWindow("gpt-6-astra")).toBe(300_000);
        expect(runtime.contextWindowKnown?.("gpt-6-sol")).toBe(true);
        expect(runtime.contextWindowKnown?.("unknown-window")).toBe(false);
        expect(runtime.contextWindow("unknown-window")).toBe(258_400);
      }),
  );

  test("merges Anthropic pages, removes duplicates, and derives reasoning capabilities", () => {
    const models = parseSubscriptionCatalog("anthropic", [
      {
        data: [
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
          { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
        ],
      },
      {
        data: [
          { id: "claude-opus-5", display_name: "duplicate" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
    expect(models[0]?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.supportedReasoningEfforts).toEqual(["none"]);
    expect(models[2]?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "max"]);
  });

  effectTest.effect(
    "uses installed Anthropic metadata without requesting the API-key-only model endpoint",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeClient("anthropic", []);
        const provider = createSubscriptionProvider({
          protocol: providerProtocols.anthropic,
          config: settingsStore(),
          client: fake.client,
        });

        const models = yield* provider.models.list;

        expect(models.map((model) => model.id)).toContain("claude-sonnet-4-6");
        expect(models.map((model) => model.id)).toContain("claude-opus-5");
        expect(fake.catalogRequests).toBe(0);
      }),
  );

  effectTest.live(
    "returns pending immediately and keeps credentials out of the auth contract",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeClient("anthropic", []);
        const provider = createSubscriptionProvider({
          protocol: providerProtocols.anthropic,
          config: settingsStore(),
          client: fake.client,
        });
        expect(yield* provider.auth.connect).toEqual({
          provider: "anthropic",
          status: "pending",
          authorizationUrl: "https://example.test/anthropic/authorize",
        });
        expect(provider.auth).not.toHaveProperty("token");
        expect(provider.auth).not.toHaveProperty("credential");
        fake.complete();
        yield* Effect.yieldNow;
        expect(yield* provider.auth.status).toEqual({
          provider: "anthropic",
          status: "signed-in",
        });
      }),
  );

  effectTest.live("reports safe login diagnostics and does not surface raw provider text", () =>
    Effect.gen(function* () {
      const makeGate = yield* sdkGateFactory();
      const completion = makeGate<OAuthConnectionStatus, OAuthHarnessError>();
      const completed = completion.promise;
      const rejectLogin = completion.reject;
      const client = {
        status: () =>
          Promise.resolve({ provider: "openai" as const, connected: false, expiresAt: null }),
        startLogin: () =>
          Promise.resolve<LoginAttempt>({
            provider: "openai",
            authorizationUrl: "https://example.test/authorize",
            completed,
            cancel: () => {},
          }),
        disconnect: () =>
          Promise.resolve({ provider: "openai" as const, connected: false, expiresAt: null }),
        modelCatalog: () => Promise.resolve([]),
      };
      const provider = createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config: settingsStore(),
        client,
      });
      expect((yield* provider.auth.connect).status).toBe("pending");
      rejectLogin(
        OAuthHarnessError.fromCode("provider_rejected", 403, {
          provider: "openai",
          operation: "token_exchange",
          providerCode: "access_denied",
          proxyRoute: "attempted",
        }),
      );
      yield* Effect.yieldNow;
      const state = yield* provider.auth.status;
      expect(state).toMatchObject({
        provider: "openai",
        status: "error",
        code: "provider_rejected",
        operation: "token_exchange",
        httpStatus: 403,
        providerCode: "access_denied",
        proxyRoute: "attempted",
      });
    }),
  );

  effectTest.live("shows a safe credential-store stage even when status reads also fail", () =>
    Effect.gen(function* () {
      const login = (yield* sdkGateFactory())<OAuthConnectionStatus, OAuthHarnessError>();
      const completed = login.promise;
      const provider = createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config: settingsStore(),
        client: {
          status: () =>
            Promise.resolve().then(() => {
              throw OAuthHarnessError.fromCode("credential_store_unavailable", null, {
                provider: "openai",
                operation: "credential_store",
                credentialStage: "read",
              });
            }),
          startLogin: () =>
            Promise.resolve<LoginAttempt>({
              provider: "openai",
              authorizationUrl: "https://example.test/authorize",
              completed,
              cancel: () => {},
            }),
          disconnect: () =>
            Promise.resolve({ provider: "openai", connected: false, expiresAt: null }),
          modelCatalog: () => Promise.resolve([]),
        },
      });
      expect(yield* provider.auth.status).toMatchObject({
        status: "error",
        credentialStage: "read",
      });
      expect((yield* provider.auth.connect).status).toBe("pending");
      login.reject(
        OAuthHarnessError.fromCode("credential_store_unavailable", null, {
          provider: "openai",
          operation: "credential_store",
          credentialStage: "write",
        }),
      );
      yield* Effect.yieldNow;
      expect(yield* provider.auth.status).toMatchObject({
        status: "error",
        code: "credential_store_unavailable",
        credentialStage: "write",
      });
    }),
  );

  effectTest.effect("cancels an in-flight login and validates provider/model/effort together", () =>
    Effect.gen(function* () {
      const config = settingsStore();
      const fake = yield* fakeClient("openai", [
        {
          models: [
            {
              slug: "gpt-6-astra",
              supported_reasoning_levels: ["low", "high"],
              default_reasoning_level: "high",
            },
          ],
        },
      ]);
      const provider = createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config,
        client: fake.client,
      });

      yield* provider.auth.connect;
      expect(yield* provider.auth.cancel).toEqual({
        provider: "openai",
        status: "signed-out",
      });
      expect(fake.cancelled).toBe(true);

      expect(yield* provider.models.select("gpt-6-astra")).toEqual({
        provider: "openai",
        model: "gpt-6-astra",
        reasoningEffort: "high",
      });
      expect(config.value).toMatchObject({
        provider: "openai",
        model: "gpt-6-astra",
        reasoningEffort: "high",
      });

      const invalid = yield* Effect.flip(provider.models.select("gpt-6-astra", "medium"));
      expect(invalid).toEqual(
        ModelUnavailable.make({
          provider: "openai",
          model: "gpt-6-astra",
          reasoningEffort: "medium",
        }),
      );
    }),
  );
});
