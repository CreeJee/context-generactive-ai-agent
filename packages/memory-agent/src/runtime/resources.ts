import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Packages this app loads from disk at run time rather than bundling: native addons (vector index,
 * keychain, image encoding). The app server build keeps them external, and the executable cannot hold them
 * (a Node SEA embeds only JS and cannot load a package from disk with `import`). The embedding
 * runtime and Kiwi are loaded the same way, by their worker scripts ({@link runtimeWorker}).
 */
interface RuntimePackages {
  readonly turbovec: typeof import("turbovec");
  readonly "@napi-rs/keyring": typeof import("@napi-rs/keyring");
  readonly sharp: typeof import("sharp");
}

/**
 * The runtime folder the executable unpacked into the storage root, or null when running from a
 * checkout. The executable sets it before the agent starts.
 */
export const runtimeRoot = () => process.env.CONTEXT_AGENT_RUNTIME ?? null;

/**
 * `require` rooted where runtime packages live: the unpacked runtime folder, or this package in a
 * checkout. Resolved from the memory-agent package rather than this module because the app bundles
 * this module into its server build.
 */
export function runtimeRequire() {
  const root = runtimeRoot();
  if (root !== null) return createRequire(join(root, "package.json"));
  return createRequire(createRequire(import.meta.url).resolve("memory-agent/package.json"));
}

/** Loads a runtime package with `require` (its CommonJS build, or require(esm) for turbovec). */
export function requireRuntime<Name extends keyof RuntimePackages>(
  name: Name,
): RuntimePackages[Name] {
  // SAFETY: each name maps to the package's own published types; `require` returns that module.
  return runtimeRequire()(name) as RuntimePackages[Name];
}

/**
 * Worker scripts. Kiwi and the embedder are plain `.mjs` files that load their runtime package; the
 * import and redaction workers are TypeScript in a checkout and bundled into one `.mjs` each for
 * the executable.
 */
export type RuntimeWorker = "kiwi-worker" | "embed-worker" | "import-worker" | "redact-worker";

/**
 * A worker script's file. In a checkout it is found through the package exports rather than next to
 * the module that starts it, because the app bundles that module into its server build while the
 * worker file stays in the package. The executable unpacks it into its runtime folder, next to
 * `node_modules`.
 */
export function runtimeWorker(name: RuntimeWorker) {
  const root = runtimeRoot();
  return root === null
    ? runtimeRequire().resolve(`memory-agent/${name}`)
    : join(root, `${name}.mjs`);
}
