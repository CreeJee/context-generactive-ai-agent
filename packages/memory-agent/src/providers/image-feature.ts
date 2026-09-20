import { Context, Data, Effect, Layer } from "effect";
import { GlobalConfig, type GlobalConfigApi } from "../config/global-config.ts";
import type { ImageRouteDecision } from "./image-router.ts";
import { ModelFeatureFlags, type ModelFeatureFlagsApi } from "./model-feature-flags.ts";

export interface ImageFeatureStatus {
  readonly featureAvailable: boolean;
  readonly imageGenerationEnabled: boolean;
  readonly imageProviderToolEnabled: boolean;
}

export interface ImageFeatureFlags {
  readonly imageGenerationAvailable: boolean;
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

export class ImageFeatureUnavailable extends Data.TaggedError("ImageFeatureUnavailable")<{
  readonly reason: "feature_flag" | "user_disabled" | "provider_tool_disabled";
}> {}

export interface ImageFeatureApi {
  readonly status: Effect.Effect<ImageFeatureStatus>;
  readonly setImageGenerationEnabled: (enabled: boolean) => Effect.Effect<ImageFeatureStatus>;
  readonly setImageProviderToolEnabled: (
    enabled: boolean,
  ) => Effect.Effect<ImageFeatureStatus, ImageFeatureUnavailable>;
}

export function decideImageContext(input: ImageContextGateInput): ImageContextGateDecision {
  const reasons: string[] = [];
  if (!input.status.featureAvailable) reasons.push("app feature flag is disabled");
  if (!input.status.imageGenerationEnabled)
    reasons.push("user image generation setting is disabled");
  if (input.intent.kind !== "generate_image") reasons.push("turn has no explicit image intent");
  if (input.route === null) reasons.push("no verified image route was selected");

  const imageGenerationAllowed = reasons.length === 0;
  const directWorkflowAllowed =
    imageGenerationAllowed && input.route?.executionMode === "direct_adapter";
  const providerToolAllowed =
    imageGenerationAllowed &&
    input.status.imageProviderToolEnabled &&
    input.route?.executionMode === "provider_tool";
  if (imageGenerationAllowed && !input.status.imageProviderToolEnabled)
    reasons.push("user Provider Tool setting is disabled");
  if (
    imageGenerationAllowed &&
    input.status.imageProviderToolEnabled &&
    input.route?.executionMode !== "provider_tool"
  )
    reasons.push("selected route is not the Provider Tool route");

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

export function makeImageFeature(
  config: GlobalConfigApi,
  flags: ImageFeatureFlags,
  modelFeatures?: ModelFeatureFlagsApi,
): ImageFeatureApi {
  const modelFeatureAvailable =
    modelFeatures === undefined
      ? Effect.succeed(true)
      : modelFeatures.decide({ provider: "openai", capability: "openai:image_generation" }).pipe(
          Effect.map((decision) => decision.allowed),
          Effect.catchAll(() => Effect.succeed(false)),
        );
  const status = Effect.map(
    Effect.all([config.read, modelFeatureAvailable]),
    ([settings, modelAllowed]): ImageFeatureStatus => ({
      featureAvailable: flags.imageGenerationAvailable && modelAllowed,
      imageGenerationEnabled: settings.imageGenerationEnabled ?? false,
      imageProviderToolEnabled: settings.imageProviderToolEnabled ?? false,
    }),
  );
  const update = (patch: {
    readonly imageGenerationEnabled?: boolean;
    readonly imageProviderToolEnabled?: boolean;
  }) => Effect.zipRight(config.update(patch), status);
  return {
    status,
    setImageGenerationEnabled: (enabled) =>
      update(
        enabled
          ? { imageGenerationEnabled: true }
          : { imageGenerationEnabled: false, imageProviderToolEnabled: false },
      ),
    setImageProviderToolEnabled: (enabled) =>
      Effect.flatMap(status, (current) =>
        enabled && (!current.featureAvailable || !current.imageGenerationEnabled)
          ? Effect.fail(
              new ImageFeatureUnavailable({
                reason: !current.featureAvailable ? "feature_flag" : "user_disabled",
              }),
            )
          : update({ imageProviderToolEnabled: enabled }),
      ),
  };
}

export class ImageFeature extends Context.Tag("memory-agent/ImageFeature")<
  ImageFeature,
  ImageFeatureApi
>() {
  static readonly layer = (flags: ImageFeatureFlags) =>
    Layer.effect(
      ImageFeature,
      Effect.gen(function* () {
        return makeImageFeature(yield* GlobalConfig, flags);
      }),
    );
  static readonly layerWithModelFeatureFlags = (flags: ImageFeatureFlags) =>
    Layer.effect(
      ImageFeature,
      Effect.gen(function* () {
        return makeImageFeature(yield* GlobalConfig, flags, yield* ModelFeatureFlags);
      }),
    );
  static readonly disabledLayer = ImageFeature.layer({ imageGenerationAvailable: false });
  static readonly layerFrom = (api: ImageFeatureApi) => Layer.succeed(ImageFeature, api);
}
