import { Effect, Result, Layer, ManagedRuntime } from "effect";
import {
  ProviderRegistry,
  ProviderToolCapabilityRegistry,
  RouteCatalog,
  RouteCatalogRefreshFailed,
  makeRouteCatalog,
  type ProviderConfiguration,
  type RouteCatalogSource,
  type RouteCatalogSnapshot,
} from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

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
  executorModel: { type: "explicit" as const, model: "gpt-image-2" as const },
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
    executorModel: { type: "explicit" as const, model: "gpt-image-2" as const },
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

describe("RouteCatalog", () => {
  it("refreshes an immutable and deterministically sorted snapshot", async () => {
    const catalog = await Effect.runPromise(makeRouteCatalog(source(), () => 123));
    const first = await Effect.runPromise(catalog.refresh);
    const second = await Effect.runPromise(catalog.refresh);
    expect(first).toMatchObject({ revision: 1, refreshedAt: 123 });
    expect(second.revision).toBe(2);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.chat)).toBe(true);
  });

  it("represents a cross-provider chat and media pairing without changing either model", async () => {
    const catalog = await Effect.runPromise(makeRouteCatalog(source()));
    await Effect.runPromise(catalog.refresh);
    const pair = await Effect.runPromise(catalog.pairChatWithMedia(chat.id, media.id));
    expect(pair).toEqual({
      initiatorChatRouteId: chat.id,
      executorMediaRouteId: media.id,
      initiatorChatProvider: "anthropic",
      executorMediaProvider: "openai",
      crossProvider: true,
    });
    expect(chat.model).toBe("claude-test");
    expect(media.executorModel).toEqual({ type: "explicit", model: "gpt-image-2" });
  });

  it("keeps provider-managed media model provenance explicit", async () => {
    const managed = {
      ...media,
      id: "media:openai:provider_tool:image_generation" as const,
      executionMode: "provider_tool" as const,
      executorModel: { type: "provider_managed" as const },
      billingAttribution: "provider_managed" as const,
    };
    const catalog = await Effect.runPromise(
      makeRouteCatalog(source({ ...loaded, media: [managed] })),
    );
    const snapshot = await Effect.runPromise(catalog.refresh);
    expect(snapshot.media[0]?.executorModel).toEqual({ type: "provider_managed" });
    expect(snapshot.media[0]?.billingAttribution).toBe("provider_managed");
  });

  it("does not replace the previous snapshot when refresh fails", async () => {
    let attempt = 0;
    const changing: RouteCatalogSource = {
      load: Effect.suspend(() => {
        attempt += 1;
        return attempt === 1
          ? Effect.succeed(loaded)
          : Effect.fail(
              new RouteCatalogRefreshFailed({
                operation: "models",
                cause: new Error("unavailable"),
              }),
            );
      }),
    };
    const catalog = await Effect.runPromise(makeRouteCatalog(changing, () => attempt));
    const first = await Effect.runPromise(catalog.refresh);
    const failure = await Effect.runPromise(Effect.result(catalog.refresh));
    expect(Result.isFailure(failure) && failure.failure._tag).toBe("RouteCatalogRefreshFailed");
    expect(await Effect.runPromise(catalog.snapshot)).toBe(first);
  });

  it("fails typed lookup for unknown routes", async () => {
    const catalog = await Effect.runPromise(makeRouteCatalog(source()));
    await Effect.runPromise(catalog.refresh);
    const result = await Effect.runPromise(
      Effect.result(catalog.media("media:openai:direct_adapter:missing")),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "UnknownCatalogRoute",
      routeType: "media",
    });
  });

  it("keeps an unknown provider-catalog model as chat while fail-closing its tools", async () => {
    const provider: ProviderConfiguration = {
      provider: "openai",
      auth: {
        provider: "openai",
        status: Effect.succeed({ provider: "openai", status: "signed-in" }),
        connect: Effect.succeed({ provider: "openai", status: "signed-in" }),
        cancel: Effect.succeed({ provider: "openai", status: "signed-out" }),
        disconnect: Effect.succeed({ provider: "openai", status: "signed-out" }),
      },
      models: {
        provider: "openai",
        list: Effect.succeed([
          {
            provider: "openai",
            id: "future-model-not-in-installed-metadata",
            displayName: "Future model",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium"],
            capabilities: { inputModalities: ["text"], toolCalling: true, reasoning: true },
          },
        ]),
        selected: Effect.succeed(null),
        acceptsImages: () => Effect.succeed(false),
        cheapestEffort: (selection) => Effect.succeed(selection),
        select: (model) => Effect.succeed({ provider: "openai", model, reasoningEffort: "medium" }),
      },
    };
    const layer = RouteCatalog.layer.pipe(
      Layer.provide(ProviderRegistry.layer([provider])),
      Layer.provide(ProviderToolCapabilityRegistry.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    const catalog = await runtime.runPromise(RouteCatalog);
    const snapshot = await runtime.runPromise(catalog.refresh);
    expect(snapshot.chat.map((route) => route.model)).toEqual([
      "future-model-not-in-installed-metadata",
    ]);
    expect(snapshot.execution).toEqual([]);
    await runtime.dispose();
  });

  it("supports a deterministic Layer override", async () => {
    const runtime = ManagedRuntime.make(RouteCatalog.layerFrom(source(), () => 7));
    const catalog = await runtime.runPromise(RouteCatalog);
    expect(await runtime.runPromise(catalog.refresh)).toMatchObject({
      revision: 1,
      refreshedAt: 7,
    });
    await runtime.dispose();
  });

  it("keeps entitlement evidence separate from authentication", () => {
    expect(chat.authentication).toMatchObject({ status: "signed-in", verified: true });
    expect(media.entitlement).toMatchObject({
      status: "unverified",
      source: "account_smoke_test_not_run",
    });
  });
});
