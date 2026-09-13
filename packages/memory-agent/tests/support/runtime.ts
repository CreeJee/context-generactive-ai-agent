import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach } from "vite-plus/test";
import { memoryAgentLayer, type MemoryAgentLayerOptions, Projects, Sessions } from "memory-agent";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function open(storage: string, options: MemoryAgentLayerOptions) {
  const runtime = ManagedRuntime.make(memoryAgentLayer(storage, options));
  cleanups.push(() => runtime.dispose());
  return runtime;
}

/**
 * A real runtime over a throwaway storage root, with one registered project and session.
 * Uses the deterministic embedder unless another one is passed.
 */
export async function testRuntime(overrides: MemoryAgentLayerOptions = {}) {
  const options = { embedder: fakeEmbedderLayer, ...overrides };
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-")));
  const storage = join(base, "storage");
  const projectRoot = join(base, "project");
  mkdirSync(projectRoot);
  cleanups.push(async () => rmSync(base, { recursive: true, force: true }));

  const runtime = open(storage, options);
  const { project, session } = await runtime.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(projectRoot);
      const session = yield* (yield* Sessions).create(project.id);
      return { project, session };
    }),
  );
  return {
    runtime,
    project,
    session,
    base,
    storage,
    /** Closes this runtime and opens a new one on the same storage, like a process restart. */
    reopen: async () => {
      await runtime.dispose();
      return open(storage, options);
    },
  };
}
