import { isTruthy } from "../truthy.ts";
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

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
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
      byProvider.has(provider) && subscriptionDependencies !== undefined
        ? subscriptionDependencies(provider)
        : Effect.fail(new ProviderUnavailable({ provider })),
    get: (provider) => {
      const configuration = byProvider.get(provider);
      return isTruthy(configuration)
        ? Effect.succeed(configuration)
        : Effect.fail(new ProviderUnavailable({ provider }));
    },
    runtime: (provider) => {
      const runtime = runtimeByProvider.get(provider);
      return isTruthy(runtime)
        ? Effect.succeed(runtime)
        : Effect.fail(new ProviderUnavailable({ provider }));
    },
  };
};

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryApi>()(
  "memory-agent/providers/registry/ProviderRegistry",
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
