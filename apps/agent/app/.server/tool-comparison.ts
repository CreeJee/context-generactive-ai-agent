import { Effect, Layer, Function as EffectFunction } from "effect";
import {
  ProviderOperationFailed,
  ProviderRegistry,
  ProviderUnavailable,
  type ModelSelection,
  type ProviderRegistryApi,
} from "memory-agent";
import type { RunTextAdapter } from "memory-agent/provider-contracts";

/** Server-owned capability only. No HTTP payload, account row or credential is accepted. */
export interface ComparisonRequestGuard {
  readonly beforeModel: (options: Parameters<RunTextAdapter["chatStream"]>[0]) => void;
  readonly beforeCatalog: () => void;
}

/**
 * Borrow the running server's provider objects, never rebuild its account/keychain clients.
 * Selection belongs to the evaluation; every authentication/configuration mutation is refused.
 * The caller supplies a separate scoped memory-agent layer and must consume SSE before disposal.
 */
export const comparisonProviderLayer: {
  (
    selection: ModelSelection,
    guard: ComparisonRequestGuard,
  ): (owner: ProviderRegistryApi) => Layer.Layer<ProviderRegistry>;
} & typeof comparisonProviderLayerBody = EffectFunction.dual(3, comparisonProviderLayerBody);
function comparisonProviderLayerBody(
  owner: ProviderRegistryApi,
  selection: ModelSelection,
  guard: ComparisonRequestGuard,
) {
  const unavailable = (provider: ModelSelection["provider"]) =>
    Effect.fail(new ProviderUnavailable({ provider }));
  const registry: ProviderRegistryApi = {
    providers: [selection.provider],
    get: (provider) =>
      provider !== selection.provider
        ? unavailable(provider)
        : Effect.map(owner.get(provider), (configuration) => {
            const rejectAuth = Effect.fail(
              new ProviderOperationFailed({ provider, operation: "auth" }),
            );
            const rejectModel = Effect.fail(
              new ProviderOperationFailed({ provider, operation: "model" }),
            );
            const list = Effect.try({
              try: guard.beforeCatalog,
              catch: () => new ProviderOperationFailed({ provider, operation: "catalog" }),
            }).pipe(Effect.andThen(configuration.models.list));
            return {
              provider,
              auth: {
                provider,
                status: configuration.auth.status,
                connect: rejectAuth,
                cancel: rejectAuth,
                disconnect: rejectAuth,
              },
              models: {
                ...configuration.models,
                list,
                acceptsImages: (model) =>
                  Effect.map(list, (models) =>
                    models.some(
                      (entry) =>
                        entry.id === model && entry.capabilities.inputModalities.includes("image"),
                    ),
                  ),
                selected: Effect.succeed(selection),
                // No production selection write, including a same-model write.
                select: () => rejectModel,
              },
            };
          }),
    runtime: (provider) =>
      provider !== selection.provider
        ? unavailable(provider)
        : Effect.map(owner.runtime(provider), (runtime) => ({
            ...runtime,
            adapter: (requested) => {
              if (
                requested.provider !== selection.provider ||
                requested.model !== selection.model ||
                requested.reasoningEffort !== selection.reasoningEffort
              )
                throw new ProviderOperationFailed({ provider, operation: "model" });
              const adapter = runtime.adapter(selection);
              // The subscription runtime issues a fresh adapter per run. Keep its receiver and
              // lease intact; wrap that run's streaming method without replacing the owner client.
              const chatStream = adapter.chatStream.bind(adapter);
              return Object.assign(adapter, {
                chatStream(options: Parameters<RunTextAdapter["chatStream"]>[0]) {
                  guard.beforeModel(options);
                  return chatStream(options);
                },
              });
            },
          })),
  };
  return Layer.succeed(ProviderRegistry, registry);
}

/** Run this Effect on the existing app runtime. It does not start or dispose that runtime. */
export const withServerToolComparison = Effect.fn("withServerToolComparison")(function* <A, E, R>(
  selection: ModelSelection,
  guard: ComparisonRequestGuard,
  use: (providers: ReturnType<typeof comparisonProviderLayer>) => Effect.Effect<A, E, R>,
) {
  const owner = yield* ProviderRegistry;
  return yield* use(comparisonProviderLayer(owner, selection, guard));
}, Effect.scoped);

export type ComparisonProviderLayer = ReturnType<typeof comparisonProviderLayer>;
