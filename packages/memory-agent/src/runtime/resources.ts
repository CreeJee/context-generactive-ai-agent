import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Packages this app loads from disk at run time rather than bundling: native addons (vector index,
 * keychain, image encoding) and the embedding runtime. The app server build keeps them external, and the executable cannot hold them
 * (a Node SEA embeds only JS and cannot load a package from disk with `import`).
 */
interface RuntimePackages {
  readonly turbovec: typeof import("turbovec");
  readonly "@napi-rs/keyring": typeof import("@napi-rs/keyring");
  readonly "@huggingface/transformers": typeof import("@huggingface/transformers");
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
