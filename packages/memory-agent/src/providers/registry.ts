import { isTruthy } from "../truthy.ts";
import { MutableHashMap, Option, Context, Effect, Layer } from "effect";
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
export function providerRegistryFrom(options: {
  readonly configurations: ReadonlyArray<ProviderConfiguration>;
  readonly runtimes?: ReadonlyArray<AgentModelRuntime> | undefined;
  readonly subscriptionDependencies?: SubscriptionDependencyResolver | undefined;
}) {
  return providerRegistryFromBody(
    options.configurations,
    options.runtimes,
    options.subscriptionDependencies,
  );
}
const providerRegistryFromBody = (
  configurations: ReadonlyArray<ProviderConfiguration>,
  runtimes: ReadonlyArray<AgentModelRuntime> = [],
  subscriptionDependencies?: SubscriptionDependencyResolver,
): ProviderRegistryApi => {
  const byProvider = MutableHashMap.fromIterable(
    configurations.map((configuration) => [configuration.provider, configuration]),
  );
  const runtimeByProvider = MutableHashMap.fromIterable(
    runtimes.map((runtime) => [runtime.provider, runtime]),
  );
  return {
    providers: [...MutableHashMap.keys(byProvider)],
    subscriptionDependencies: (provider) =>
      MutableHashMap.has(byProvider, provider) && subscriptionDependencies !== undefined
        ? subscriptionDependencies(provider)
        : Effect.fail(new ProviderUnavailable({ provider })),
    get: (provider) => {
      const configuration = Option.getOrUndefined(MutableHashMap.get(byProvider, provider));
      return isTruthy(configuration)
        ? Effect.succeed(configuration)
        : Effect.fail(new ProviderUnavailable({ provider }));
    },
    runtime: (provider) => {
      const runtime = Option.getOrUndefined(MutableHashMap.get(runtimeByProvider, provider));
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
      providerRegistryFrom({
        configurations: configurations,
        runtimes: runtimes,
        subscriptionDependencies: subscriptionDependencies,
      }),
    );
  }
}
