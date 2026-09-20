import { Effect, Either, Schema } from "effect";
import {
  CrossProviderMediaConsent,
  CrossProviderMediaConsentMode,
  ImageFeature,
  ModelFeatureFlags,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.image";

const ImageSettingsAction = Schema.Union(
  Schema.Struct({ action: Schema.Literal("image_generation"), enabled: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("provider_tool"), enabled: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("features_global"), enabled: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("features_openai"), enabled: Schema.Boolean }),
  Schema.Struct({ action: Schema.Literal("feature_image"), enabled: Schema.Boolean }),
  Schema.Struct({
    action: Schema.Literal("cross_provider_media"),
    mode: CrossProviderMediaConsentMode,
  }),
);

const imageSettingsView = Effect.gen(function* () {
  const feature = yield* ImageFeature;
  const modelFeatures = yield* ModelFeatureFlags;
  const crossProviderMediaConsent = yield* CrossProviderMediaConsent;
  return {
    ...(yield* feature.status),
    modelFeatureFlags: yield* modelFeatures.read,
    crossProviderMediaConsent: yield* crossProviderMediaConsent.read,
  };
});

/** GET /api/settings/image: server feature availability and the two independent user toggles. */
export async function loader() {
  return agent.runPromise(Effect.map(imageSettingsView, (status) => Response.json(status)));
}

/** POST /api/settings/image: update a user toggle; the server feature flag remains authoritative. */
export async function action({ request }: Route.ActionArgs) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = await readJson(request, ImageSettingsAction);
  if (Either.isLeft(body))
    return Response.json({ error: "invalid_image_settings_action" }, { status: 400 });

  const response = Effect.gen(function* () {
    const feature = yield* ImageFeature;
    const modelFeatures = yield* ModelFeatureFlags;
    const crossProviderMediaConsent = yield* CrossProviderMediaConsent;
    const command = body.right;
    switch (command.action) {
      case "image_generation":
        yield* feature.setImageGenerationEnabled(command.enabled);
        break;
      case "provider_tool":
        yield* feature.setImageProviderToolEnabled(command.enabled);
        break;
      case "features_global":
        yield* modelFeatures.set({ type: "global" }, command.enabled);
        break;
      case "features_openai":
        yield* modelFeatures.set({ type: "provider", provider: "openai" }, command.enabled);
        break;
      case "feature_image":
        yield* modelFeatures.set(
          { type: "capability", capability: "openai:image_generation" },
          command.enabled,
        );
        break;
      case "cross_provider_media":
        yield* crossProviderMediaConsent.set(
          {
            initiatorProvider: "anthropic",
            executorProvider: "openai",
            capability: "media.image.generate",
          },
          command.mode,
        );
        break;
    }
    return Response.json(yield* imageSettingsView);
  }).pipe(
    Effect.catchTag("ImageFeatureUnavailable", (failure) =>
      Effect.succeed(
        Response.json(
          { error: "image_feature_unavailable", reason: failure.reason },
          { status: 409 },
        ),
      ),
    ),
  );
  return agent.runPromise(response);
}
