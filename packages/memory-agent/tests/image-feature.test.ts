import { it as effectTest } from "@effect/vitest";
import { Effect, MutableRef } from "effect";
import {
  ImageExecutorModel,
  decideImageContext,
  makeImageFeature,
  ImageRouteDecision,
  type Settings,
} from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

const directRoute: ImageRouteDecision = ImageRouteDecision.selected({
  mode: "auto",
  preference: "balanced",
  initiatorChatRouteId: "chat:anthropic:claude-test",
  initiatorChatModel: "claude-test",
  executorMediaRouteId: "media:openai:direct_adapter:gpt-image-2",
  executorMediaModel: ImageExecutorModel.explicit({ model: "gpt-image-2" }),
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
});
const providerToolRoute: ImageRouteDecision = {
  ...directRoute,
  executorMediaRouteId: "media:openai:provider_tool:image_generation",
  executorMediaModel: ImageExecutorModel.provider_managed(),
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
    inputs.forEach((input) => {
      const decision = decideImageContext(input);
      expect(decision.injectProviderTool).toBe(false);
      expect(decision.injectWorkflowPrompt).toBe(false);
      expect(decision.directWorkflowAllowed).toBe(false);
    });
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
    const settings = MutableRef.make(initial);
    const config = {
      read: Effect.sync(() => MutableRef.get(settings)),
      update: (patch: Partial<Settings>) =>
        Effect.sync(() =>
          MutableRef.updateAndGet(settings, (current) => ({ ...current, ...patch })),
        ),
    };
    return {
      feature: makeImageFeature(config),
      read: () => MutableRef.get(settings),
    };
  }

  effectTest.effect("defaults image generation off", () =>
    Effect.gen(function* () {
      const { feature } = fixture();
      expect(yield* feature.status).toEqual({ imageGenerationEnabled: false });
    }),
  );

  effectTest.effect("persists the single image generation setting", () =>
    Effect.gen(function* () {
      const { feature, read } = fixture();
      expect(yield* feature.setImageGenerationEnabled(true)).toEqual({
        imageGenerationEnabled: true,
      });
      expect(read()).toMatchObject({ imageGenerationEnabled: true });
      expect(yield* feature.setImageGenerationEnabled(false)).toEqual({
        imageGenerationEnabled: false,
      });
    }),
  );
});
