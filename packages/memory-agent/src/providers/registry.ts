import { Context, Effect, Layer } from "effect";
import {
  ProviderUnavailable,
  type AgentModelRuntime,
  type ProviderConfiguration,
  type ProviderId,
  type SubscriptionAccountProvider,
} from "./contracts.ts";

import type { SubscriptionRuntimeDependencies } from "./subscription-runtime.ts";

export type SubscriptionDependencyResolver = (
  provider: SubscriptionAccountProvider,
) => Effect.Effect<SubscriptionRuntimeDependencies, ProviderUnavailable>;

export interface ProviderRegistryApi {
  readonly providers: ReadonlyArray<ProviderId>;
  readonly get: (provider: ProviderId) => Effect.Effect<ProviderConfiguration, ProviderUnavailable>;
  readonly runtime: (provider: ProviderId) => Effect.Effect<AgentModelRuntime, ProviderUnavailable>;
  /** Central dependencies only: resolving does not select an account or acquire a run lease. */
  readonly subscriptionDependencies?: SubscriptionDependencyResolver;
}

export const providerRegistryFrom = (
  configurations: ReadonlyArray<ProviderConfiguration>,
  runtimes: ReadonlyArray<AgentModelRuntime> = [],
  subscriptionDependencies?: SubscriptionDependencyResolver,
): ProviderRegistryApi => {
  const byProvider = new Map(
    configurations.map((configuration) => [configuration.provider, configuration]),
  );
  const runtimeByProvider = new Map(runtimes.map((runtime) => [runtime.provider, runtime]));
  return {
    providers: [...byProvider.keys()],
    subscriptionDependencies: (provider) =>
      byProvider.has(provider) && subscriptionDependencies
        ? subscriptionDependencies(provider)
        : Effect.fail(new ProviderUnavailable({ provider })),
    get: (provider) => {
      const configuration = byProvider.get(provider);
      return configuration
        ? Effect.succeed(configuration)
        : Effect.fail(new ProviderUnavailable({ provider }));
    },
    runtime: (provider) => {
      const runtime = runtimeByProvider.get(provider);
      return runtime ? Effect.succeed(runtime) : Effect.fail(new ProviderUnavailable({ provider }));
    },
  };
};

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryApi>()(
  "memory-agent/ProviderRegistry",
) {
  static layer(
    configurations: ReadonlyArray<ProviderConfiguration>,
    runtimes?: ReadonlyArray<AgentModelRuntime>,
    subscriptionDependencies?: SubscriptionDependencyResolver,
  ) {
    return Layer.succeed(
      ProviderRegistry,
      providerRegistryFrom(configurations, runtimes, subscriptionDependencies),
    );
  }
}
