import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Exit, Fiber, FileSystem, Layer, ManagedRuntime, Path, Scope } from "effect";
import { afterEach } from "vite-plus/test";
import { memoryAgentLayer, type MemoryAgentLayerOptions, Projects, Sessions } from "memory-agent";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { testProvider as makeTestProvider, type TestProviderOptions } from "./provider.ts";

// The native test runner owns this Scope across every runtime reopen in one test.
let fixtureScope = Scope.makeUnsafe();
afterEach(() => {
  const scope = fixtureScope;
  fixtureScope = Scope.makeUnsafe();
  return Effect.runPromise(Scope.close(scope, Exit.void));
});

const open = Effect.fnUntraced(function* (
  storage: string,
  options: MemoryAgentLayerOptions,
  scope: Scope.Scope,
) {
  const runtime = ManagedRuntime.make(memoryAgentLayer(storage, options));
  yield* Scope.addFinalizer(
    scope,
    Effect.promise(() => runtime.dispose()),
  );
  return runtime;
});

export interface TestRuntimeOptions extends MemoryAgentLayerOptions {
  readonly testProvider?: TestProviderOptions;
}

/**
 * A real runtime over a throwaway storage root, with one registered project and session.
 * Uses the deterministic embedder unless another one is passed.
 */
export function testRuntime(overrides: TestRuntimeOptions = {}) {
  const owner = fixtureScope;
  const create = Effect.gen(function* () {
    const scope = yield* Scope.fork(owner);
    const setup = Effect.gen(function* () {
      const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
      const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
      const path = yield* Effect.provideContext(Path.Path, services);
      const run = Effect.runPromiseWith(yield* Effect.context());
      // Interpretation is a model call; tests that need it run it by hand. Secrets never touch the
      // real keychain.
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-" });
      const base = yield* fs.realPath(temporary);
      const home = path.join(base, "home");
      yield* fs.makeDirectory(home);
      const { testProvider: providerOptions, ...layerOverrides } = overrides;
      const provider =
        providerOptions !== undefined ? makeTestProvider(providerOptions) : undefined;
      const baseOptions: MemoryAgentLayerOptions = {
        embedder: fakeEmbedderLayer,
        morphAnalyzer: fakeMorphLayer,
        interpretAutomatically: false,
        summarizeAutomatically: false,
        secrets: SecretStore.memory,
        // The user's real ~/.agents/skills stays out of tests, and so do the app's own skills: a test
        // lists exactly the skills it writes. `skills.test.ts` checks the built-in ones on their own.
        skillsHome: home,
        skillsBuiltin: path.join(base, "builtin-skills"),
        // So does the user's real ~/.claude and ~/.codex; a test writes its own transcripts here.
        importsHome: home,
        importsWatching: false,
        sweepSecrets: false,
        ...layerOverrides,
      };
      const options: MemoryAgentLayerOptions =
        provider !== undefined ? { ...baseOptions, providerRegistry: provider.layer } : baseOptions;
      const storage = path.join(base, "storage");
      const projectRoot = path.join(base, "project");
      yield* fs.makeDirectory(projectRoot);
      const runtime = yield* open(storage, options, scope);
      const { project, session } = yield* Effect.provideContext(
        Effect.gen(function* () {
          const project = yield* (yield* Projects).add(projectRoot);
          const session = yield* (yield* Sessions).create(project.id);
          return { project, session };
        }),
        yield* runtime.contextEffect,
      );
      return {
        runtime,
        project,
        session,
        base,
        home,
        storage,
        provider,
        /** Close the current runtime while the fixture Scope retains storage for its replacement. */
        reopen: () => runtime.dispose().then(() => run(open(storage, options, scope))),
      };
    }).pipe(Effect.provideService(Scope.Scope, scope));
    // Stop unfinished setup before closing its resource Scope when the test ends.
    const fiber = yield* Effect.forkIn(setup, owner);
    return yield* Fiber.join(fiber);
  });
  // Preserve the Promise factory consumed by the native SDK and test-runner boundaries.
  return Effect.runPromise(create);
}
