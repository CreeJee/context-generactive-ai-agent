import { Context, Effect, Layer } from "effect";
import {
  ProviderUnavailable,
  type AgentModelRuntime,
  type ProviderConfiguration,
  type ProviderId,
} from "./contracts.ts";

export interface ProviderRegistryApi {
  readonly providers: ReadonlyArray<ProviderId>;
  readonly get: (provider: ProviderId) => Effect.Effect<ProviderConfiguration, ProviderUnavailable>;
  readonly runtime: (provider: ProviderId) => Effect.Effect<AgentModelRuntime, ProviderUnavailable>;
}

export const providerRegistryFrom = (
  configurations: ReadonlyArray<ProviderConfiguration>,
  runtimes: ReadonlyArray<AgentModelRuntime> = [],
): ProviderRegistryApi => {
  const byProvider = new Map(
    configurations.map((configuration) => [configuration.provider, configuration]),
  );
  const runtimeByProvider = new Map(runtimes.map((runtime) => [runtime.provider, runtime]));
  return {
    providers: [...byProvider.keys()],
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
  ) {
    return Layer.succeed(ProviderRegistry, providerRegistryFrom(configurations, runtimes));
  }
}
