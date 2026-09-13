import { ManagedRuntime } from "effect";
import { defaultStorageRoot, memoryAgentLayer } from "memory-agent";

function createAgentRuntime() {
  const runtime = ManagedRuntime.make(memoryAgentLayer(defaultStorageRoot));
  // Stop the codex child process and release the vector index lock with the server.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void runtime.dispose().finally(() => process.exit(0)));
  return runtime;
}

declare global {
  // Survives dev-server module reloads so codex and the index lock are not started twice.
  var contextGeneractiveAgent: ReturnType<typeof createAgentRuntime> | undefined;
}

/** The single memory-agent runtime of this server process. Server-only. */
export const agent = (globalThis.contextGeneractiveAgent ??= createAgentRuntime());
