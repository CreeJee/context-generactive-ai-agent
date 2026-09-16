import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach } from "vite-plus/test";
import { memoryAgentLayer, type MemoryAgentLayerOptions, Projects, Sessions } from "memory-agent";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";

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
  // Interpretation is a model call; tests that need it run it by hand. Secrets never touch the
  // real keychain.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-")));
  const home = join(base, "home");
  mkdirSync(home);
  const options = {
    embedder: fakeEmbedderLayer,
    morphAnalyzer: fakeMorphLayer,
    interpretAutomatically: false,
    secrets: SecretStore.memory,
    // The user's real ~/.agents/skills stays out of tests, and so do the app's own skills: a test
    // lists exactly the skills it writes. `skills.test.ts` checks the built-in ones on their own.
    skillsHome: home,
    skillsBuiltin: join(base, "builtin-skills"),
    // So does the user's real ~/.claude and ~/.codex; a test writes its own transcripts here.
    importsHome: home,
    importsWatching: false,
    sweepSecrets: false,
    ...overrides,
  };
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
    home,
    storage,
    /** Closes this runtime and opens a new one on the same storage, like a process restart. */
    reopen: async () => {
      await runtime.dispose();
      return open(storage, options);
    },
  };
}
