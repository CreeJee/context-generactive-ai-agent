import { Effect } from "effect";
import {
  decideImageContext,
  makeImageFeature,
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
const enabled = { imageGenerationEnabled: true };
const intent = { kind: "generate_image" as const, source: "composer_action" as const };

describe("image context gate", () => {
  it("fails closed for every user, intent and route gate", () => {
    const inputs = [
      { status: { imageGenerationEnabled: false }, intent, route: providerToolRoute },
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

  it("allows a direct adapter for an explicit image request", () => {
    expect(decideImageContext({ status: enabled, intent, route: directRoute })).toMatchObject({
      imageGenerationAllowed: true,
      directWorkflowAllowed: true,
      injectProviderTool: false,
      injectWorkflowPrompt: false,
    });
  });

  it("uses the same image setting for a selected Provider Tool route", () => {
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
      feature: makeImageFeature(config),
      read: () => settings,
    };
  }

  it("defaults image generation off", async () => {
    const { feature } = fixture();
    expect(await Effect.runPromise(feature.status)).toEqual({ imageGenerationEnabled: false });
  });

  it("persists the single image generation setting", async () => {
    const { feature, read } = fixture();
    expect(await Effect.runPromise(feature.setImageGenerationEnabled(true))).toEqual({
      imageGenerationEnabled: true,
    });
    expect(read()).toMatchObject({ imageGenerationEnabled: true });
    expect(await Effect.runPromise(feature.setImageGenerationEnabled(false))).toEqual({
      imageGenerationEnabled: false,
    });
  });
});
