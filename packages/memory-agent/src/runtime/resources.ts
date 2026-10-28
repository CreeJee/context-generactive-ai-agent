import { createRequire } from "node:module";
import { Config, ConfigProvider, Effect, MutableRef, Option, Schema } from "effect";
import { workerData } from "node:worker_threads";
import { path } from "./synchronous-path.ts";

/**
 * Packages this app loads from disk at run time rather than bundling: native addons (vector index,
 * keychain, image encoding). The app server build keeps them external, and the executable cannot hold them
 * (a Node SEA embeds only JS and cannot load a package from disk with `import`). The embedding
 * runtime and Kiwi are loaded the same way, by their worker scripts ({@link runtimeWorker}).
 */
interface RuntimePackages {
  readonly turbovec: typeof import("turbovec");
  readonly "@napi-rs/keyring": typeof import("@napi-rs/keyring");
  readonly sharp: typeof import("sharp", { with: { "resolution-mode": "require" } });
  /** Not native, but finds its helper binaries next to its own files, so it cannot be bundled. */
  readonly "@anthropic-ai/sandbox-runtime": typeof import("@anthropic-ai/sandbox-runtime");
}

/**
 * The runtime folder the executable unpacked into the storage root, or null when running from a
 * checkout. The executable sets it before the agent starts.
 */
const WorkerRuntime = Schema.Struct({
  contextAgentRuntime: Schema.Struct({ root: Schema.NullOr(Schema.String) }),
});
const inheritedRuntime = Schema.decodeUnknownOption(WorkerRuntime)(workerData);
const configuredRuntime = MutableRef.make(
  Option.map(inheritedRuntime, ({ contextAgentRuntime }) => contextAgentRuntime),
);

/** Explicit host bootstrap; worker copies receive the same value through workerData. */
export function configureRuntimeRoot(root: string | null): void {
  MutableRef.set(configuredRuntime, Option.some({ root }));
}

export const runtimeRoot: Effect.Effect<string | null> = Effect.suspend(() =>
  Option.match(MutableRef.get(configuredRuntime), {
    onSome: ({ root }) => Effect.succeed(root),
    onNone: () =>
      Config.String("CONTEXT_AGENT_RUNTIME").pipe(
        Config.withDefault(null),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
        ),
        Effect.orDie,
      ),
  }),
);

/** Preserve worker setup and inherited SDK environment without mutating process.env. */
export const runtimeWorkerOptions = <A extends object>(setup: A) =>
  Effect.map(runtimeRoot, (root) => ({ workerData: { ...setup, contextAgentRuntime: { root } } }));

/**
 * `require` rooted where runtime packages live: the unpacked runtime folder, or this package in a
 * checkout. Resolved from the memory-agent package rather than this module because the app bundles
 * this module into its server build.
 */
const requireAt = (root: string | null) =>
  createRequire(
    Option.match(Option.fromNullishOr(root), {
      onNone: () => createRequire(import.meta.url).resolve("memory-agent/package.json"),
      onSome: (root) => path.join(root, "package.json"),
    }),
  );
export const runtimeRequire = Effect.map(runtimeRoot, requireAt);

/** Loads a runtime package with `require` (its CommonJS build, or require(esm) for turbovec). */
export const requireRuntime = <Name extends keyof RuntimePackages>(name: Name) =>
  Effect.flatMap(runtimeRoot, (root) =>
    // SAFETY: each name maps to the package's own published types; `require` returns that module.
    Effect.try(() => requireAt(root)(name) as RuntimePackages[Name]),
  );

/**
 * Worker scripts. Kiwi and the embedder are plain `.mjs` files that load their runtime package; the
 * import and redaction workers are TypeScript in a checkout and bundled into one `.mjs` each for
 * the executable.
 */
export type RuntimeWorker =
  | "kiwi-worker"
  | "embed-worker"
  | "import-worker"
  | "redact-worker"
  | "native-search-worker"
  | "sandbox-worker"
  | "code-worker";

/**
 * A worker script's file. In a checkout it is found through the package exports rather than next to
 * the module that starts it, because the app bundles that module into its server build while the
 * worker file stays in the package. The executable unpacks it into its runtime folder, next to
 * `node_modules`.
 */
export const runtimeWorker = (name: RuntimeWorker) =>
  Effect.flatMap(runtimeRoot, (root) =>
    root === null
      ? Effect.try(() => requireAt(root).resolve(`memory-agent/${name}`))
      : Effect.succeed(path.join(root, `${name}.mjs`)),
  );
