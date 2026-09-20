import { Effect, Either } from "effect";
import {
  decideImageContext,
  makeImageFeature,
  makeModelFeatureFlags,
  type ImageRouteDecision,
  type Settings,
} from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

const directRoute: ImageRouteDecision = {
  type: "selected",
  mode: "auto",
  preference: "balanced",
  initiatorChatRouteId: "chat:anthropic:claude-test",
  initiatorChatModel: "claude-test",
  executorMediaRouteId: "media:openai:direct_adapter:gpt-image-2",
  executorMediaModel: { type: "explicit", model: "gpt-image-2" },
  provider: "openai",
  initiatorProvider: "anthropic",
  crossProvider: true,
  crossProviderConsentMode: "ask",
  crossProviderApprovalRequired: true,
  accountId: "account-1",
  executionMode: "direct_adapter",
  score: 1,
  reasons: ["fixture"],
  ranking: [],
};
const providerToolRoute: ImageRouteDecision = {
  ...directRoute,
  executorMediaRouteId: "media:openai:provider_tool:image_generation",
  executorMediaModel: { type: "provider_managed" },
  executionMode: "provider_tool",
};
const enabled = {
  featureAvailable: true,
  imageGenerationEnabled: true,
  imageProviderToolEnabled: true,
};
const intent = { kind: "generate_image" as const, source: "composer_action" as const };

describe("image context gate", () => {
  it("fails closed for every feature/user/intent gate", () => {
    const inputs = [
      { status: { ...enabled, featureAvailable: false }, intent, route: providerToolRoute },
      { status: { ...enabled, imageGenerationEnabled: false }, intent, route: providerToolRoute },
      {
        status: enabled,
        intent: { kind: "none" as const, source: "api" as const },
        route: providerToolRoute,
      },
      { status: enabled, intent, route: null },
    ];
    for (const input of inputs) {
      const decision = decideImageContext(input);
      expect(decision.injectProviderTool).toBe(false);
      expect(decision.injectWorkflowPrompt).toBe(false);
      expect(decision.directWorkflowAllowed).toBe(false);
    }
  });

  it("does not inject image context for a direct adapter workflow", () => {
    expect(decideImageContext({ status: enabled, intent, route: directRoute })).toMatchObject({
      imageGenerationAllowed: true,
      directWorkflowAllowed: true,
      injectProviderTool: false,
      injectWorkflowPrompt: false,
    });
  });

  it("requires the separate Provider Tool toggle", () => {
    expect(
      decideImageContext({
        status: { ...enabled, imageProviderToolEnabled: false },
        intent,
        route: providerToolRoute,
      }),
    ).toMatchObject({ injectProviderTool: false, injectWorkflowPrompt: false });
    expect(decideImageContext({ status: enabled, intent, route: providerToolRoute })).toMatchObject(
      {
        providerToolAllowed: true,
        injectProviderTool: true,
        injectWorkflowPrompt: true,
        directWorkflowAllowed: false,
      },
    );
  });
});

describe("ImageFeature settings", () => {
  function fixture(initial: Settings = {}) {
    let settings = initial;
    const config = {
      read: Effect.sync(() => settings),
      update: (patch: Partial<Settings>) =>
        Effect.sync(() => {
          settings = { ...settings, ...patch };
          return settings;
        }),
    };
    return {
      feature: makeImageFeature(config, { imageGenerationAvailable: true }),
      read: () => settings,
    };
  }

  it("defaults both user settings off", async () => {
    const { feature } = fixture();
    expect(await Effect.runPromise(feature.status)).toEqual({
      featureAvailable: true,
      imageGenerationEnabled: false,
      imageProviderToolEnabled: false,
    });
  });

  it("uses the same persisted model feature flag for direct and Provider Tool routes", async () => {
    let settings: Settings = {
      imageGenerationEnabled: true,
      imageProviderToolEnabled: true,
      modelFeatureFlags: {
        version: 1,
        global: false,
        providers: { openai: true },
        capabilities: { "openai:image_generation": true },
        models: {},
        routes: {},
      },
    };
    const config = {
      read: Effect.sync(() => settings),
      update: (patch: Partial<Settings>) =>
        Effect.sync(() => (settings = { ...settings, ...patch })),
    };
    const flags = makeModelFeatureFlags(config, ["openai:image_generation"]);
    const feature = makeImageFeature(config, { imageGenerationAvailable: true }, flags);
    const blocked = await Effect.runPromise(feature.status);
    expect(blocked.featureAvailable).toBe(false);
    expect(
      decideImageContext({ status: blocked, intent, route: directRoute }).directWorkflowAllowed,
    ).toBe(false);
    expect(
      decideImageContext({ status: blocked, intent, route: providerToolRoute }).injectProviderTool,
    ).toBe(false);
    await Effect.runPromise(flags.set({ type: "global" }, true));
    expect((await Effect.runPromise(feature.status)).featureAvailable).toBe(true);
  });

  it("turning image generation off also turns Provider Tool off", async () => {
    const { feature, read } = fixture({
      imageGenerationEnabled: true,
      imageProviderToolEnabled: true,
    });
    await Effect.runPromise(feature.setImageGenerationEnabled(false));
    expect(read()).toMatchObject({
      imageGenerationEnabled: false,
      imageProviderToolEnabled: false,
    });
  });

  it("cannot enable Provider Tool while the feature or user toggle is off", async () => {
    const { feature } = fixture();
    const result = await Effect.runPromise(
      Effect.either(feature.setImageProviderToolEnabled(true)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("ImageFeatureUnavailable");
  });
});
