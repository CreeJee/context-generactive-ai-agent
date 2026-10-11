import { NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, ManagedRuntime, Function as EffectFunction } from "effect";
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

// Config is evaluated when the runtime first builds its services, after CLI options are applied.
type MemoryAgentLayer = ReturnType<typeof memoryAgentLayer>;
let configuredStorageRoot: string | undefined;

/** Called by the bundled server entry before the first request builds any agent service. */
export function configureAgentBackend(options: {
  readonly storageRoot: string;
  readonly runtimeRoot: string | null;
}): void {
  configuredStorageRoot = options.storageRoot;
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
type AgentRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<typeof agentLayer> | Layer.Success<typeof NodeServices.layer>,
  Layer.Error<typeof agentLayer>
>;

function createAgentRuntime(): AgentRuntime {
  // The server entry configures storage before the first request builds this layer.
  return ManagedRuntime.make(agentLayer.pipe(Layer.provideMerge(NodeServices.layer)));
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
