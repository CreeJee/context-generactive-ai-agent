import { isTruthy } from "../truthy.ts";
import { Iterable, MutableHashMap, Option, Context, Effect, Layer } from "effect";
import {
  ProviderUnavailable,
  type AgentModelRuntime,
  type CatalogTarget,
  type ModelSelection,
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
  /**
   * The provider as a selection sees it: a compatible one lists the models of the endpoint account
   * it names, not of the selected one.
   */
  readonly configurationOf: (
    target: CatalogTarget,
  ) => Effect.Effect<ProviderConfiguration, ProviderUnavailable>;
  /** The runtime a selection runs on; a compatible one runs on the endpoint account it names. */
  readonly runtime: (
    selection: ModelSelection,
  ) => Effect.Effect<AgentModelRuntime, ProviderUnavailable>;
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
    Iterable.map(
      configurations,
      (configuration) => [configuration.provider, configuration] as const,
    ),
  );
  const runtimeByProvider = MutableHashMap.fromIterable(
    Iterable.map(runtimes, (runtime) => [runtime.provider, runtime] as const),
  );
  const get = (provider: ProviderId) => {
    const configuration = Option.getOrUndefined(MutableHashMap.get(byProvider, provider));
    return isTruthy(configuration)
      ? Effect.succeed(configuration)
      : Effect.fail(ProviderUnavailable.make({ provider }));
  };
  return {
    providers: [...MutableHashMap.keys(byProvider)],
    subscriptionDependencies: (provider) =>
      MutableHashMap.has(byProvider, provider) && subscriptionDependencies !== undefined
        ? subscriptionDependencies(provider)
        : Effect.fail(ProviderUnavailable.make({ provider })),
    get,
    configurationOf: ({ provider }) => get(provider),
    runtime: ({ provider }) => {
      const runtime = Option.getOrUndefined(MutableHashMap.get(runtimeByProvider, provider));
      return isTruthy(runtime)
        ? Effect.succeed(runtime)
        : Effect.fail(ProviderUnavailable.make({ provider }));
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
