import { NodeCrypto } from "@effect/platform-node";
import { Config, Effect, Layer, ManagedRuntime } from "effect";
import { defaultStorageRoot, memoryAgentLayer, stopAllCommands } from "memory-agent";

// Config is evaluated when the runtime first builds its services, after CLI options are applied.
const agentLayer = Layer.unwrap(
  Config.String("CONTEXT_AGENT_HOME").pipe(
    Config.withDefault(defaultStorageRoot),
    Effect.map(memoryAgentLayer),
  ),
);
type AgentRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<typeof agentLayer> | import("effect").Crypto.Crypto,
  Layer.Error<typeof agentLayer>
>;

function createAgentRuntime(): AgentRuntime {
  // The storage root is read when the first request builds the layer, so the executable can set
  // CONTEXT_AGENT_HOME (its --storage option) after this module is loaded.
  const runtime = ManagedRuntime.make(Layer.merge(agentLayer, NodeCrypto.layer));
  // Stop child commands and release the vector index lock with the server. SIGHUP is a closed
  // terminal, and on Windows a closed console window (it has no SIGTERM).
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      stopAllCommands();
      void runtime.dispose().finally(() => process.exit(0));
    });
  return runtime;
}

declare global {
  // Survives dev-server module reloads so the runtime and index lock are not started twice.
  var contextGeneractiveAgent: ReturnType<typeof createAgentRuntime> | undefined;
}

/** The single memory-agent runtime of this server process. Server-only. */
export const agent = (globalThis.contextGeneractiveAgent ??= createAgentRuntime());
