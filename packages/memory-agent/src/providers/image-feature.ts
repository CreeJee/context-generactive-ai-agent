import { Context, Effect, Layer } from "effect";
import { GlobalConfig, type GlobalConfigApi } from "../config/global-config.ts";
import type { ImageRouteDecision } from "./image-router.ts";

export interface ImageFeatureStatus {
  readonly imageGenerationEnabled: boolean;
}

export interface ImageTurnIntent {
  readonly kind: "none" | "generate_image";
  readonly source: "composer_action" | "api";
}

export interface ImageContextGateInput {
  readonly status: ImageFeatureStatus;
  readonly intent: ImageTurnIntent;
  readonly route: ImageRouteDecision | null;
}

export interface ImageContextGateDecision {
  readonly imageGenerationAllowed: boolean;
  readonly providerToolAllowed: boolean;
  readonly injectProviderTool: boolean;
  readonly injectWorkflowPrompt: boolean;
  readonly directWorkflowAllowed: boolean;
  readonly reasons: readonly string[];
}

export interface ImageFeatureApi {
  readonly status: Effect.Effect<ImageFeatureStatus>;
  readonly setImageGenerationEnabled: (enabled: boolean) => Effect.Effect<ImageFeatureStatus>;
}

export function decideImageContext(input: ImageContextGateInput): ImageContextGateDecision {
  const reasons: string[] = [];
  if (!input.status.imageGenerationEnabled)
    reasons.push("user image generation setting is disabled");
  if (input.intent.kind !== "generate_image") reasons.push("turn has no explicit image intent");
  if (input.route === null) reasons.push("no eligible image route was selected");

  const imageGenerationAllowed = reasons.length === 0;
  const directWorkflowAllowed =
    imageGenerationAllowed && input.route?.executionMode === "direct_adapter";
  const providerToolAllowed =
    imageGenerationAllowed && input.route?.executionMode === "provider_tool";

  return Object.freeze({
    imageGenerationAllowed,
    providerToolAllowed,
    injectProviderTool: providerToolAllowed,
    injectWorkflowPrompt: providerToolAllowed,
    directWorkflowAllowed,
    reasons: Object.freeze(reasons),
  });
}

export const imageProviderWorkflowPrompt = `Image generation is available for this turn only.
Use the image_generation Provider Tool only for the user's explicit image request.
Do not claim a specific executor image model when the provider does not disclose one.
Do not retry or switch to another paid route after failure without user confirmation.`;

export function makeImageFeature(config: GlobalConfigApi): ImageFeatureApi {
  const status = Effect.map(config.read, (settings): ImageFeatureStatus => ({
    imageGenerationEnabled: settings.imageGenerationEnabled ?? false,
  }));
  return {
    status,
    setImageGenerationEnabled: (enabled) =>
      Effect.zipRight(config.update({ imageGenerationEnabled: enabled }), status),
  };
}

export class ImageFeature extends Context.Tag("memory-agent/ImageFeature")<
  ImageFeature,
  ImageFeatureApi
>() {
  static readonly layer = Layer.effect(
    ImageFeature,
    Effect.gen(function* () {
      return makeImageFeature(yield* GlobalConfig);
    }),
  );
  static readonly layerFrom = (api: ImageFeatureApi) => Layer.succeed(ImageFeature, api);
}
