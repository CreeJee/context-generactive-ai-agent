import { Effect, Result, Schema } from "effect";
import {
  CrossProviderMediaConsent,
  CrossProviderMediaConsentMode,
  ImageFeature,
} from "memory-agent";
import { agent } from "~/.server/agent";
import { readJson, rejectCrossSite } from "~/.server/http";
import type { Route } from "./+types/settings.image";

const ImageSettingsAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("image_generation"), enabled: Schema.Boolean }),
  Schema.Struct({
    action: Schema.Literal("cross_provider_media"),
    mode: CrossProviderMediaConsentMode,
  }),
]);

const imageSettingsView = Effect.gen(function* () {
  const feature = yield* ImageFeature;
  const crossProviderMediaConsent = yield* CrossProviderMediaConsent;
  return {
    ...(yield* feature.status),
    crossProviderMediaConsent: yield* crossProviderMediaConsent.read,
  };
});

/** GET /api/settings/image: the image-generation preference and cross-provider consent. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function loader() {
  return agent.runPromise(Effect.map(imageSettingsView, (status) => Response.json(status)));
}

/** POST /api/settings/image: update an image-generation preference without restarting the app. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export function action({ request }: Route.ActionArgs) {
  return agent.runPromise(
    Effect.gen(function* () {
      const rejected = rejectCrossSite(request);
      if (rejected !== null) return rejected;
      const body = yield* Effect.tryPromise(() => readJson(request, ImageSettingsAction));
      if (Result.isFailure(body))
        return Response.json({ error: "invalid_image_settings_action" }, { status: 400 });

      const response = Effect.gen(function* () {
        const feature = yield* ImageFeature;
        const crossProviderMediaConsent = yield* CrossProviderMediaConsent;
        const command = body.success;
        switch (command.action) {
          case "image_generation":
            yield* feature.setImageGenerationEnabled(command.enabled);
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
      });
      return yield* response;
    }),
  );
}
