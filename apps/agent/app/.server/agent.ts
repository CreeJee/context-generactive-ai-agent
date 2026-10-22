import { Config, Effect, Layer, ManagedRuntime, Function as EffectFunction } from "effect";
import { nodePlatformLayer, type NodePlatform } from "memory-agent/node-platform";
import {
  defaultStorageRoot,
  memoryAgentLayer,
  stopAllCommands,
  type ModelSelection,
} from "memory-agent";
import { configureRuntimeRoot } from "memory-agent/runtime-resources";
import {
  withServerToolComparison,
  type ComparisonProviderLayer,
  type ComparisonRequestGuard,
} from "./tool-comparison.ts";
import { buildConfigLayer, type BuildServerConfig } from "./build-config.ts";
import { observabilityLayer } from "./observability.ts";

// Config is evaluated when the runtime first builds its services, after CLI options are applied.
type MemoryAgentLayer = ReturnType<typeof memoryAgentLayer>;
let configuredStorageRoot: string | undefined;
let configuredBuildConfig: BuildServerConfig = {};
let configuredRelease = "0.0.0-dev";

/** Called by the bundled server entry before the first request builds any agent service. */
export function configureAgentBackend(options: {
  readonly storageRoot: string;
  readonly runtimeRoot: string | null;
  /** Settings embedded in the executable; the runtime environment overrides each of them. */
  readonly buildConfig: BuildServerConfig;
  /** The release version this executable was built as; defect reports name it. */
  readonly release: string;
}): void {
  configuredStorageRoot = options.storageRoot;
  configuredBuildConfig = options.buildConfig;
  configuredRelease = options.release;
  configureRuntimeRoot(options.runtimeRoot);
}
const agentLayer: Layer.Layer<
  Layer.Success<MemoryAgentLayer>,
  Layer.Error<MemoryAgentLayer> | Config.ConfigError,
  Layer.Services<MemoryAgentLayer>
> = Layer.unwrap(
  Effect.suspend(() =>
    configuredStorageRoot === undefined
      ? Config.String("CONTEXT_AGENT_HOME").pipe(Config.withDefault(defaultStorageRoot))
      : Effect.succeed(configuredStorageRoot),
  ).pipe(Effect.map(memoryAgentLayer)),
);
// The tracer sits below the agent services so their construction and every later run are traced.
const runtimeLayer: Layer.Layer<
  Layer.Success<typeof agentLayer> | Layer.Success<typeof observabilityLayer> | NodePlatform,
  Layer.Error<typeof agentLayer> | Layer.Error<typeof observabilityLayer>
> = agentLayer.pipe(
  Layer.provide(
    Layer.suspend(() =>
      buildConfigLayer({ ...configuredBuildConfig, CONTEXT_AGENT_RELEASE: configuredRelease }),
    ),
  ),
  Layer.provideMerge(observabilityLayer),
  Layer.provideMerge(nodePlatformLayer),
);
type AgentRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<typeof runtimeLayer>,
  Layer.Error<typeof runtimeLayer>
>;

function createAgentRuntime(): AgentRuntime {
  // The server entry configures storage before the first request builds this layer.
  return ManagedRuntime.make(runtimeLayer);
}

/** The single memory-agent runtime of this server process. Server-only. */
export const agent = createAgentRuntime();

/** The backend owner's Scope disposes this exact runtime from the server build. */
export function disposeAgent(): Promise<void> {
  stopAllCommands();
  return agent.dispose();
}

/** Internal evaluation capability; borrowing providers never exposes a DB or credentials to HTTP. */
export const runToolComparison: {
  <A, E>(
    guard: ComparisonRequestGuard,
    use: (providers: ComparisonProviderLayer) => Effect.Effect<A, E>,
  ): (selection: ModelSelection) => Promise<A>;
} & typeof runToolComparisonBody = EffectFunction.dual(3, runToolComparisonBody);
function runToolComparisonBody<A, E>(
  selection: ModelSelection,
  guard: ComparisonRequestGuard,
  use: (providers: ComparisonProviderLayer) => Effect.Effect<A, E>,
) {
  return agent.runPromise(withServerToolComparison(selection, guard, use));
}
