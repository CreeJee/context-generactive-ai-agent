import { it as effectTest } from "@effect/vitest";
import { Stream, DateTime, Deferred, Effect, Exit, Fiber, MutableRef } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, test } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import type { JsonValue } from "../src/json.ts";
import {
  OAuthHarnessError,
  type LoginAttempt,
  type OAuthConnectionStatus,
} from "../src/oauth/validation-harness.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { AuthConnectionState, ModelUnavailable } from "../src/providers/contracts.ts";
import {
  createSubscriptionProvider,
  parseSubscriptionCatalog,
} from "../src/providers/subscription-provider.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";

const settingsStore = () => {
  const settings = MutableRef.make<Settings>({});
  return {
    get value() {
      return MutableRef.get(settings);
    },
    read: Effect.sync(() => MutableRef.get(settings)),
    update: (patch: Partial<Settings>) =>
      Effect.sync(() => MutableRef.updateAndGet(settings, (current) => ({ ...current, ...patch }))),
  };
};

const fakeClient = Effect.fn("subscriptionProviderTest.fakeClient")(function* (
  provider: "openai" | "anthropic",
  pages: ReadonlyArray<JsonValue>,
) {
  const connected = MutableRef.make(false);
  const cancelled = MutableRef.make(false);
  const catalogRequests = MutableRef.make(0);
  const completion = yield* Deferred.make<OAuthConnectionStatus>();
  const attempt: LoginAttempt = {
    provider,
    authorizationUrl: `https://example.test/${provider}/authorize`,
    completed: Deferred.await(completion),
    cancel: Effect.sync(() => {
      MutableRef.set(cancelled, true);
    }),
  };
  return {
    client: {
      status: Effect.sync(() => ({
        provider,
        connected: MutableRef.get(connected),
        expiresAt: null,
      })),
      startLogin: Effect.succeed(attempt),
      disconnect: Effect.sync(() => ({
        provider,
        connected: MutableRef.setAndGet(connected, false),
        expiresAt: null,
      })),
      modelCatalog: Effect.sync(() => {
        MutableRef.increment(catalogRequests);
        return pages;
      }),
      stream: () => Stream.empty,
    },
    complete: Effect.gen(function* () {
      MutableRef.set(connected, true);
      yield* Deferred.succeed(completion, {
        provider,
        connected: true,
        expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + 60_000,
      });
    }),
    get cancelled() {
      return MutableRef.get(cancelled);
    },
    get catalogRequests() {
      return MutableRef.get(catalogRequests);
    },
  };
});

const catalogPages = (id: string, window = 400_000) => [
  { models: [{ slug: id, context_window: window }] },
];
const gatedCatalog = Effect.fn("subscriptionProviderTest.gatedCatalog")(function* () {
  const gates: {
    release: (pages: ReadonlyArray<JsonValue>) => Effect.Effect<boolean>;
    reject: Effect.Effect<boolean>;
    interrupted: boolean;
  }[] = [];
  const key = MutableRef.make("profile-a");
  const fake = yield* fakeClient("openai", []);
  const provider = yield* createSubscriptionProvider({
    protocol: providerProtocols.openai,
    config: settingsStore(),
    catalogKey: () => MutableRef.get(key),
    client: {
      ...fake.client,
      modelCatalog: Effect.gen(function* () {
        const completion = yield* Deferred.make<ReadonlyArray<JsonValue>, OAuthHarnessError>();
        const gate = {
          release: (pages: ReadonlyArray<JsonValue>) => Deferred.succeed(completion, pages),
          reject: Deferred.fail(
            completion,
            OAuthHarnessError.fromCode("transport_unavailable", null),
          ),
          interrupted: false,
        };
        gates.push(gate);
        return yield* Deferred.await(completion).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              gate.interrupted = true;
            }),
          ),
        );
      }),
    },
  });
  return {
    provider,
    gates,
    changeProfile: (next: string) => {
      MutableRef.set(key, next);
    },
  };
});

describe("subscription catalog concurrency", () => {
  effectTest.effect("retains success until the 30-second TTL expires", () =>
    Effect.gen(function* () {
      const { provider, gates } = yield* gatedCatalog();
      const first = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      yield* gates[0]!.release(catalogPages("first"));
      yield* Fiber.join(first);
      yield* TestClock.adjust("29 seconds");
      expect((yield* provider.models.list)[0]?.id).toBe("first");
      expect(gates).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      const fresh = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      yield* gates[1]!.release(catalogPages("fresh"));
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
        yield* gates[0]!.release(catalogPages("shared"));
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
      yield* gates[0]!.reject;
      yield* Effect.forEach(
        [owner, waiter],
        (fiber) =>
          Effect.map(Fiber.await(fiber), (exit) => expect(Exit.isFailure(exit)).toBe(true)),
        { discard: true },
      );
      const retry = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      yield* gates[1]!.release(catalogPages("retry"));
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
      yield* gates[1]!.release(catalogPages("current", 300_000));
      yield* Fiber.join(current);
      yield* gates[0]!.release(catalogPages("old"));
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
      yield* gates[0]!.release(catalogPages("old"));
      yield* Fiber.join(old);
      expect(provider.contextWindow("old")).toBeNull();
      const fresh = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
      expect(gates).toHaveLength(2);
      yield* gates[1]!.release(catalogPages("fresh"));
      expect((yield* Fiber.join(fresh))[0]?.id).toBe("fresh");
    }),
  );

  effectTest.live(
    "cancelling a shared waiter leaves its owner alive; owner interruption permits retry",
    () =>
      Effect.gen(function* () {
        const { provider, gates } = yield* gatedCatalog();
        const owner = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        const waiter = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        const remaining = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        yield* Fiber.interrupt(waiter);
        expect(gates[0]?.interrupted).toBe(false);
        expect(gates).toHaveLength(1);
        yield* gates[0]!.release(catalogPages("shared"));
        yield* Effect.forEach(
          [owner, remaining],
          (fiber) =>
            Effect.map(Fiber.join(fiber), (models) => expect(models[0]?.id).toBe("shared")),
          { discard: true },
        );
        yield* provider.auth.disconnect;
        const interruptedOwner = yield* Effect.forkChild(provider.models.list, {
          startImmediately: true,
        });
        const interruptedWaiter = yield* Effect.forkChild(provider.models.list, {
          startImmediately: true,
        });
        yield* Fiber.interrupt(interruptedOwner);
        expect(gates[1]?.interrupted).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(interruptedWaiter))).toBe(true);
        yield* gates[1]!.release(catalogPages("interrupted"));
        const retry = yield* Effect.forkChild(provider.models.list, { startImmediately: true });
        expect(gates).toHaveLength(3);
        yield* gates[2]!.release(catalogPages("retry"));
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
        const provider = yield* createSubscriptionProvider({
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
        const provider = yield* createSubscriptionProvider({
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
        const provider = yield* createSubscriptionProvider({
          protocol: providerProtocols.anthropic,
          config: settingsStore(),
          client: fake.client,
        });
        expect(yield* provider.auth.connect).toEqual(
          AuthConnectionState.pending({
            provider: "anthropic",
            authorizationUrl: "https://example.test/anthropic/authorize",
          }),
        );
        expect(provider.auth).not.toHaveProperty("token");
        expect(provider.auth).not.toHaveProperty("credential");
        yield* fake.complete;
        yield* Effect.yieldNow;
        expect(yield* provider.auth.status).toEqual(
          AuthConnectionState["signed-in"]({ provider: "anthropic" }),
        );
      }),
  );

  effectTest.live("reports safe login diagnostics and does not surface raw provider text", () =>
    Effect.gen(function* () {
      const completion = yield* Deferred.make<OAuthConnectionStatus, OAuthHarnessError>();
      const signedOut = Effect.succeed({
        provider: "openai" as const,
        connected: false,
        expiresAt: null,
      });
      const client = {
        status: signedOut,
        startLogin: Effect.succeed<LoginAttempt>({
          provider: "openai",
          authorizationUrl: "https://example.test/authorize",
          completed: Deferred.await(completion),
          cancel: Effect.void,
        }),
        disconnect: signedOut,
        modelCatalog: Effect.succeed([]),
      };
      const provider = yield* createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config: settingsStore(),
        client,
      });
      expect(AuthConnectionState.$is("pending")(yield* provider.auth.connect)).toBe(true);
      yield* Deferred.fail(
        completion,
        OAuthHarnessError.fromCode("provider_rejected", 403, {
          provider: "openai",
          operation: "token_exchange",
          providerCode: "access_denied",
          proxyRoute: "attempted",
        }),
      );
      yield* Effect.yieldNow;
      const state = yield* provider.auth.status;
      expect(AuthConnectionState.$is("error")(state)).toBe(true);
      expect(state).toMatchObject({
        provider: "openai",
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
      const login = yield* Deferred.make<OAuthConnectionStatus, OAuthHarnessError>();
      const provider = yield* createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config: settingsStore(),
        client: {
          status: Effect.fail(
            OAuthHarnessError.fromCode("credential_store_unavailable", null, {
              provider: "openai",
              operation: "credential_store",
              credentialStage: "read",
            }),
          ),
          startLogin: Effect.succeed<LoginAttempt>({
            provider: "openai",
            authorizationUrl: "https://example.test/authorize",
            completed: Deferred.await(login),
            cancel: Effect.void,
          }),
          disconnect: Effect.succeed({ provider: "openai", connected: false, expiresAt: null }),
          modelCatalog: Effect.succeed([]),
        },
      });
      const unreadable = yield* provider.auth.status;
      expect(AuthConnectionState.$is("error")(unreadable)).toBe(true);
      expect(unreadable).toMatchObject({ credentialStage: "read" });
      expect(AuthConnectionState.$is("pending")(yield* provider.auth.connect)).toBe(true);
      yield* Deferred.fail(
        login,
        OAuthHarnessError.fromCode("credential_store_unavailable", null, {
          provider: "openai",
          operation: "credential_store",
          credentialStage: "write",
        }),
      );
      yield* Effect.yieldNow;
      const unwritable = yield* provider.auth.status;
      expect(AuthConnectionState.$is("error")(unwritable)).toBe(true);
      expect(unwritable).toMatchObject({
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
      const provider = yield* createSubscriptionProvider({
        protocol: providerProtocols.openai,
        config,
        client: fake.client,
      });

      yield* provider.auth.connect;
      expect(yield* provider.auth.cancel).toEqual(
        AuthConnectionState["signed-out"]({ provider: "openai" }),
      );
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
