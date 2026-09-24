import { Context, Effect, Layer } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import type { ModelSelection, ProviderId, ProviderServices } from "./contracts.ts";
import { ProviderRegistry } from "./registry.ts";

export interface ResolvedProvider {
  readonly selection: ModelSelection;
  readonly services: ProviderServices;
}

const make = Effect.gen(function* () {
  const config = yield* GlobalConfig;
  const registry = yield* ProviderRegistry;

  const provider = Effect.map(config.read, (settings): ProviderId => settings.provider ?? "openai");
  const selected = Effect.map(config.read, (settings): ModelSelection | null =>
    settings.provider && settings.model && settings.reasoningEffort
      ? {
          provider: settings.provider,
          model: settings.model,
          reasoningEffort: settings.reasoningEffort,
        }
      : null,
  );

  const resolve = (selection: ModelSelection) =>
    Effect.gen(function* () {
      const configuration = yield* registry.get(selection.provider);
      const runtime = yield* registry.runtime(selection.provider);
      return {
        selection,
        services: { ...configuration, runtime },
      } satisfies ResolvedProvider;
    });

  const authFor = (provider: ProviderId) =>
    Effect.flatMap(registry.get(provider), ({ auth }) => auth.status).pipe(
      Effect.orElseSucceed(() => ({
        provider,
        status: "error" as const,
        message: "Provider authentication is unavailable.",
      })),
    );

  return {
    provider,
    selected,
    resolve,
    models: (selection: ModelSelection) =>
      Effect.map(resolve(selection), ({ services }) => services.models),
    runtime: (selection: ModelSelection) =>
      Effect.map(resolve(selection), ({ services }) => services.runtime),
    authFor,
    auth: (selection: ModelSelection) => authFor(selection.provider),
  };
});

/** Resolves the saved provider/model pair without silently falling back to another provider. */
export class ActiveProvider extends Context.Service<ActiveProvider, Effect.Success<typeof make>>()(
  "memory-agent/ActiveProvider",
) {
  static readonly layer = Layer.effect(ActiveProvider, make);
}
