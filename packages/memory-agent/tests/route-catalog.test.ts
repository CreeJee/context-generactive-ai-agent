import { it as effectTest } from "@effect/vitest";
import { Context, Effect, MutableRef, Result, Layer } from "effect";
import {
  AuthConnectionState,
  ImageExecutorModel,
  ProviderOperationFailed,
  ProviderRegistry,
  ProviderToolCapabilityRegistry,
  RouteCatalog,
  RouteCatalogRefreshFailed,
  UnknownCatalogRoute,
  makeRouteCatalog,
  type ModelCatalog,
  type ProviderConfiguration,
  type ProviderId,
  type RouteCatalogSource,
  type RouteCatalogSnapshot,
} from "memory-agent";
import { describe, expect } from "vite-plus/test";
import { TestClock } from "effect/testing";

const chat = {
  type: "chat" as const,
  id: "chat:anthropic:claude-test" as const,
  provider: "anthropic" as const,
  model: "claude-test",
  displayName: "Claude Test",
  capabilities: { inputModalities: ["text", "image"] as const, toolCalling: true, reasoning: true },
  reasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  authentication: {
    mechanism: "subscription_oauth" as const,
    status: "signed-in" as const,
    verified: true,
  },
  entitlement: {
    status: "verified" as const,
    source: "provider_model_catalog" as const,
    detail: "fixture",
  },
};

const media = {
  type: "media" as const,
  id: "media:openai:direct_adapter:gpt-image-2" as const,
  provider: "openai" as const,
  executionMode: "direct_adapter" as const,
  executorModel: ImageExecutorModel.explicit({ model: "gpt-image-2" }),
  operations: ["generate", "edit"] as const,
  authentication: {
    mechanism: "openai_api_key" as const,
    status: "signed-out" as const,
    verified: false,
  },
  entitlement: {
    status: "unverified" as const,
    source: "account_smoke_test_not_run" as const,
    detail: "fixture",
  },
  billingAttribution: "executor_model" as const,
  contract: {
    id: "openai:direct_adapter:gpt-image-2" as const,
    provider: "openai" as const,
    executionMode: "direct_adapter" as const,
    executorModel: ImageExecutorModel.explicit({ model: "gpt-image-2" }),
    verification: "unverified" as const,
    productionEnabled: false,
    authentication: "openai_api_key" as const,
    billingAttribution: "executor_model" as const,
    operations: ["generate", "edit"] as const,
    input: {
      text: true as const,
      images: true,
      maximumSourceImages: 16,
      mask: true,
      remoteUrlFetch: "disabled_by_default" as const,
    },
    output: {
      sources: ["url", "base64"] as const,
      mime: "provider_option_or_detect_bytes" as const,
      temporaryUrlPossible: true,
      persistenceRequired: true,
    },
    usage: {
      tokenUsagePossible: true,
      rawProviderUsagePreserved: false,
      costKnownBeforeExecution: false as const,
    },
    cancellation: "request_abort_signal" as const,
    evidence: ["fixture"],
  },
};

const execution = {
  type: "execution" as const,
  id: "execution:anthropic:claude-test:anthropic:web_search" as const,
  provider: "anthropic" as const,
  model: "claude-test",
  toolId: "anthropic:web_search" as const,
  category: "network.search" as const,
  authentication: chat.authentication,
  entitlement: {
    status: "unverified" as const,
    source: "installed_model_metadata" as const,
    detail: "fixture",
  },
  requiredAuth: ["provider_account"] as const,
  cost: "provider_metered" as const,
};

const loaded: Omit<RouteCatalogSnapshot, "revision" | "refreshedAt"> = {
  chat: [chat],
  media: [media],
  execution: [execution],
};
const source = (value = loaded): RouteCatalogSource => ({ load: Effect.succeed(value) });

const model = (providerId: ProviderId, id: string) => ({
  provider: providerId,
  id,
  displayName: "Future model",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["medium"],
  capabilities: { inputModalities: ["text" as const], toolCalling: true, reasoning: true },
});

const provider = (providerId: ProviderId, list: ModelCatalog["list"]): ProviderConfiguration => ({
  provider: providerId,
  auth: {
    provider: providerId,
    status: Effect.succeed(AuthConnectionState["signed-in"]({ provider: providerId })),
    connect: Effect.succeed(AuthConnectionState["signed-in"]({ provider: providerId })),
    cancel: Effect.succeed(AuthConnectionState["signed-out"]({ provider: providerId })),
    disconnect: Effect.succeed(AuthConnectionState["signed-out"]({ provider: providerId })),
  },
  models: {
    provider: providerId,
    list,
    selected: Effect.succeed(null),
    acceptsImages: () => Effect.succeed(false),
    cheapestEffort: (selection) => Effect.succeed(selection),
    select: (selected) =>
      Effect.succeed({ provider: providerId, model: selected, reasoningEffort: "medium" }),
  },
});

/** The catalog the app builds from its provider registry. */
const catalogOf = Effect.fnUntraced(function* (configuration: ProviderConfiguration) {
  const services = yield* Layer.build(
    RouteCatalog.layer.pipe(
      Layer.provide(ProviderRegistry.layer([configuration])),
      Layer.provide(ProviderToolCapabilityRegistry.layer),
    ),
  );
  return Context.get(services, RouteCatalog);
});

describe("RouteCatalog", () => {
  effectTest.effect("refreshes an immutable and deterministically sorted snapshot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(123);
      const catalog = yield* catalogOf(
        provider("openai", Effect.succeed([model("openai", "gpt-b"), model("openai", "gpt-a")])),
      );
      const first = yield* catalog.refresh;
      const second = yield* catalog.refresh;
      expect(first).toMatchObject({ revision: 1, refreshedAt: 123 });
      expect(second.revision).toBe(2);
      expect(second.chat.map((route) => route.model)).toEqual(["gpt-a", "gpt-b"]);
      expect(Object.isFrozen(second)).toBe(true);
      expect(Object.isFrozen(second.chat)).toBe(true);
    }),
  );

  effectTest.effect("does not replace the previous snapshot when refresh fails", () =>
    Effect.gen(function* () {
      const attempt = MutableRef.make(0);
      const catalog = yield* catalogOf(
        provider(
          "openai",
          Effect.suspend(() =>
            MutableRef.incrementAndGet(attempt) === 1
              ? Effect.succeed([model("openai", "gpt-a")])
              : Effect.fail(
                  ProviderOperationFailed.make({ provider: "openai", operation: "catalog" }),
                ),
          ),
        ),
      );
      const first = yield* catalog.refresh;
      const failure = yield* Effect.flip(catalog.refresh);
      expect(failure).toBeInstanceOf(RouteCatalogRefreshFailed);
      expect(yield* catalog.snapshot).toBe(first);
    }),
  );

  effectTest.effect("fails typed lookup for unknown routes", () =>
    Effect.gen(function* () {
      const catalog = yield* makeRouteCatalog(source());
      yield* catalog.refresh;
      const result = yield* Effect.result(catalog.media("media:openai:direct_adapter:missing"));
      expect(Result.isFailure(result) && result.failure).toEqual(
        UnknownCatalogRoute.make({
          routeType: "media",
          id: "media:openai:direct_adapter:missing",
        }),
      );
    }),
  );

  effectTest.effect.each([
    {
      providerId: "openai" as const,
      modelId: "future-model-not-in-installed-metadata",
      mechanism: "subscription_oauth",
    },
    { providerId: "openai-compatible" as const, modelId: "gpt-5", mechanism: "openai_compatible" },
  ])(
    "keeps $providerId models as chat without inventing native tools",
    ({ providerId, modelId, mechanism }) =>
      Effect.gen(function* () {
        const catalog = yield* catalogOf(
          provider(providerId, Effect.succeed([model(providerId, modelId)])),
        );
        const snapshot = yield* catalog.refresh;
        expect(snapshot.chat.map((route) => route.model)).toEqual([modelId]);
        expect(snapshot.chat[0]?.authentication).toMatchObject({
          mechanism,
          verified: providerId === "openai",
        });
        expect(snapshot.chat[0]?.entitlement).toMatchObject({
          status: providerId === "openai" ? "verified" : "unverified",
          source: providerId === "openai" ? "provider_model_catalog" : "endpoint_configuration",
        });
        expect(snapshot.execution).toEqual([]);
      }),
  );

  effectTest.effect("uses the runtime clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const catalog = yield* makeRouteCatalog(source());
      expect(yield* catalog.refresh).toMatchObject({ revision: 1, refreshedAt: 1_000 });
      yield* TestClock.adjust("1 second");
      expect(yield* catalog.refresh).toMatchObject({ revision: 2, refreshedAt: 2_000 });
    }),
  );
});
