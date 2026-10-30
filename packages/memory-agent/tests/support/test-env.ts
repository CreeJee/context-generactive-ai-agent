import { layer } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Option, Path, Ref, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { memoryAgentLayer, type MemoryAgentLayerOptions, Projects, Sessions } from "memory-agent";
import type { Project } from "../../src/projects/projects.ts";
import type { Session } from "../../src/sessions/sessions.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import {
  testProvider as makeTestProvider,
  type TestProvider,
  type TestProviderOptions,
} from "./provider.ts";
import { OpenSqlClient } from "./sql.ts";

type AgentLayer = ReturnType<typeof memoryAgentLayer>;
/** Every service the composition root provides. */
export type AgentServices = Layer.Success<AgentLayer>;
type AgentError = Layer.Error<AgentLayer>;

export interface TestEnvOptions extends MemoryAgentLayerOptions {
  readonly testProvider?: TestProviderOptions;
  /** Runs on the storage root before the first agent opens, e.g. to seed an older release's DB. */
  readonly beforeOpen?: (
    storage: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}

/**
 * A real memory-agent over a throwaway storage root, with one registered project and session.
 *
 * `TestEnv.layer` provides this service together with every agent service, so a test can yield
 * `Workflows` or `SqlClient` directly. `reopen` restarts the agent over the same storage; services
 * yielded before it belong to the closed agent, so a test that reopens reads them again through
 * `use`.
 */
export class TestEnv extends Context.Service<
  TestEnv,
  {
    readonly project: Project;
    readonly session: Session;
    readonly base: string;
    readonly home: string;
    readonly storage: string;
    readonly provider: TestProvider | undefined;
    /** Run an Effect against the agent that is currently open. */
    readonly use: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentError, Exclude<R, AgentServices>>;
    /** Close the open agent, then open a new one over the same storage. */
    readonly reopen: Effect.Effect<void, AgentError>;
  }
>()("memory-agent/tests/support/test-env/TestEnv") {
  static layer(options: TestEnvOptions = {}) {
    return Layer.effectContext(makeTestEnv(options)).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    );
  }
}

const makeTestEnv = Effect.fnUntraced(function* (overrides: TestEnvOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  // The temporary directory is acquired first, so its removal runs after every agent closes and
  // SQLite's WAL/SHM files are no longer mapped.
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-" }));
  const home = path.join(base, "home");
  const storage = path.join(base, "storage");
  const projectRoot = path.join(base, "project");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(projectRoot);
  const { testProvider: providerOptions, beforeOpen, ...layerOverrides } = overrides;
  yield* beforeOpen === undefined ? Effect.void : beforeOpen(storage);
  const provider = providerOptions === undefined ? undefined : makeTestProvider(providerOptions);
  const baseOptions: MemoryAgentLayerOptions = {
    embedder: fakeEmbedderLayer,
    morphAnalyzer: fakeMorphLayer,
    // Interpretation and summaries are model calls; tests that need them run them by hand.
    interpretAutomatically: false,
    summarizeAutomatically: false,
    secrets: SecretStore.memory,
    // The user's real skills, ~/.claude and ~/.codex stay out of tests: a test lists exactly what
    // it writes. `skills.test.ts` checks the built-in skills on their own.
    skillsHome: home,
    skillsBuiltin: path.join(base, "builtin-skills"),
    importsHome: home,
    importsWatching: false,
    sweepSecrets: false,
    ...layerOverrides,
  };
  const options: MemoryAgentLayerOptions =
    provider === undefined ? baseOptions : { ...baseOptions, providerRegistry: provider.layer };

  const open = Effect.gen(function* () {
    const agentScope = yield* Scope.fork(scope);
    const context = yield* Layer.buildWithScope(memoryAgentLayer(storage, options), agentScope);
    return { context, scope: agentScope };
  });
  const current = yield* Ref.make(yield* open);

  // Inside `use` the open agent's own `SqlClient` is the one fixture SQL reaches.
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Ref.get(current), ({ context }) =>
      Effect.provideContext(effect, Context.add(context, OpenSqlClient, Option.none())),
    );
  const reopen = Effect.gen(function* () {
    yield* Scope.close((yield* Ref.get(current)).scope, Exit.void);
    yield* Ref.set(current, yield* open);
  });

  const { context } = yield* Ref.get(current);
  const { project, session } = yield* Effect.provideContext(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(projectRoot);
      const session = yield* (yield* Sessions).create(project.id);
      return { project, session };
    }),
    context,
  );
  return context.pipe(
    Context.add(
      TestEnv,
      TestEnv.of({ project, session, base, home, storage, provider, use, reopen }),
    ),
    Context.add(OpenSqlClient, Option.some(use(SqlClient.SqlClient))),
  );
});

/**
 * A test block sharing one agent. Tests keep the real clock, since stored timestamps and
 * leases are part of what they check, and each test isolates itself with its own session.
 */
export const testAgent = (options?: TestEnvOptions) =>
  layer(TestEnv.layer(options), { excludeTestServices: true });

/**
 * A new session in the test project. Tests that share one agent each take their own session, so
 * workflow, queue and run state never leak between them; it is read through `use`, so it also
 * works after `reopen`.
 */
export const freshSession = Effect.gen(function* () {
  const env = yield* TestEnv;
  const session = yield* env.use(
    Effect.flatMap(Sessions, (sessions) => sessions.create(env.project.id)),
  );
  return session.id;
});
