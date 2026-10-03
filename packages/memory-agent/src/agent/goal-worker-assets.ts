import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Schema } from "effect";
import { runtimeGoalSdkMetadata, runtimeWorker } from "../runtime/resources.ts";

const dependencyMap = Schema.Record(Schema.String, Schema.String);
const packageMetadata = Schema.Struct({
  dependencies: Schema.optional(dependencyMap),
  peerDependencies: Schema.optional(dependencyMap),
  optionalDependencies: Schema.optional(dependencyMap),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optional(Schema.Boolean) })),
  ),
});

const modules = ["full-loop-worker.ts", "full-loop-codec.ts", "full-loop-rpc-client.ts"] as const;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export interface SavedGoalExecutionAssets {
  readonly goalInstanceId: string;
  readonly sourceGeneration: string;
  readonly manifestHash: string;
  readonly canonicalWorkerUrl: string;
}

const snapshotManifest = Schema.Struct({
  goalInstanceId: Schema.String,
  sourceGeneration: Schema.String,
  canonicalWorkerUrl: Schema.String,
  tree: Schema.Array(Schema.Array(Schema.String)),
});
const manifestName = "goal-assets-manifest.json";

/** Enumerate without following links; every link must resolve to a canonical copied directory. */
function snapshotTree(root: string): string[][] {
  if (realpathSync(root) !== resolve(root)) throw new Error("Noncanonical Goal snapshot root");
  const tree: string[][] = [];
  let bytes = 0;
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === manifestName) continue;
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      const stat = lstatSync(path);
      if (tree.length >= 30000) throw new Error("Goal snapshot tree exceeds bounds");
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!target.startsWith(root + "/") || !lstatSync(target).isDirectory())
          throw new Error("Goal snapshot link escapes copied tree");
        tree.push([relative, "link", readlinkSync(path), target.slice(root.length + 1)]);
      } else if (stat.isDirectory()) {
        tree.push([relative, "directory"]);
        walk(path);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024) throw new Error("Goal snapshot bytes exceed bounds");
        tree.push([relative, "file", digest(readFileSync(path))]);
      } else throw new Error("Unsupported Goal snapshot file");
    }
  }
  walk(root);
  return tree;
}

export interface GoalExecutionAssets extends SavedGoalExecutionAssets {
  readonly goalInstanceId: string;
  /** Independent of Goal/Plan revisions and per-run capability generations. */
  readonly sourceGeneration: string;
  readonly workerUrl: URL;
  readonly manifestHash: string;
}

/** Owner-local registry. No run admission, owner/tool code pinning or automatic adoption. */
export function makeGoalWorkerAssetsRegistry(
  options: {
    readonly sourceDirectory?: string;
    readonly sdkEntry?: string;
    readonly temporaryDirectory?: string;
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(join(options.temporaryDirectory ?? tmpdir(), "goal-worker-assets-")),
  );
  const goals = new Map<string, GoalExecutionAssets>();
  let disposed = false;
  let activeLeases = 0;

  function verify(saved: SavedGoalExecutionAssets): GoalExecutionAssets {
    if (disposed || !saved.goalInstanceId || !saved.sourceGeneration)
      throw new Error("Inactive Goal asset registry");
    const url = new URL(saved.canonicalWorkerUrl);
    if (url.protocol !== "file:" || url.href !== saved.canonicalWorkerUrl)
      throw new Error("Noncanonical Goal worker URL");
    const workerPath = fileURLToPath(url);
    const destination = dirname(dirname(workerPath));
    if (
      destination.slice(destination.lastIndexOf("/") + 1) !== saved.sourceGeneration ||
      workerPath !== join(destination, "worker", modules[0]) ||
      pathToFileURL(workerPath).href !== saved.canonicalWorkerUrl
    )
      throw new Error("Goal snapshot identity mismatch");
    const manifestPath = join(destination, manifestName);
    if (!lstatSync(manifestPath).isFile()) throw new Error("Invalid Goal snapshot manifest");
    const bytes = readFileSync(manifestPath);
    if (digest(bytes) !== saved.manifestHash)
      throw new Error("Goal snapshot manifest hash mismatch");
    const manifest = Schema.decodeUnknownSync(snapshotManifest)(JSON.parse(bytes.toString("utf8")));
    if (
      manifest.goalInstanceId !== saved.goalInstanceId ||
      manifest.sourceGeneration !== saved.sourceGeneration ||
      manifest.canonicalWorkerUrl !== saved.canonicalWorkerUrl ||
      JSON.stringify(manifest.tree) !== JSON.stringify(snapshotTree(destination))
    )
      throw new Error("Goal snapshot identity or tree mismatch");
    const canonicalWorkerUrl = saved.canonicalWorkerUrl;
    return Object.freeze({
      goalInstanceId: saved.goalInstanceId,
      sourceGeneration: saved.sourceGeneration,
      manifestHash: saved.manifestHash,
      canonicalWorkerUrl,
      get workerUrl() {
        return new URL(canonicalWorkerUrl);
      },
    });
  }

  function capture() {
    // Resolve only for new capture: cold adoption never requires replacement live assets.
    const source = options.sourceDirectory ?? dirname(runtimeWorker("full-loop-worker"));
    const sdkEntry = options.sdkEntry ?? runtimeGoalSdkMetadata();
    const files = new Map<string, Buffer>();
    const packages = new Map<string, { index: number; dependencies: Map<string, string> }>();
    let size = 0;
    const put = (path: string) => {
      const bytes = readFileSync(path);
      size += bytes.length;
      if (size > 64 * 1024 * 1024 || files.size >= 20000)
        throw new Error("Goal asset snapshot exceeds bounded capture");
      files.set(path, bytes);
    };
    function packageRoot(entry: string): string {
      let cursor = dirname(entry);
      while (!existsSync(join(cursor, "package.json"))) {
        const parent = dirname(cursor);
        if (parent === cursor) throw new Error("Unavailable SDK package metadata");
        cursor = parent;
      }
      return realpathSync(cursor);
    }
    function dependencyRoot(from: string, name: string): string | undefined {
      let cursor = from;
      while (true) {
        const candidate = join(cursor, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
        const parent = dirname(cursor);
        if (parent === cursor) return undefined;
        cursor = parent;
      }
    }
    function visit(directory: string) {
      if (packages.has(directory)) return;
      const record = { index: packages.size, dependencies: new Map<string, string>() };
      packages.set(directory, record);
      function walk(path: string) {
        for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const child = join(path, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (entry.isFile()) put(child);
          else throw new Error("Unsupported SDK asset symlink or special file");
        }
      }
      walk(directory);
      const metadata = Schema.decodeUnknownSync(packageMetadata)(
        JSON.parse(files.get(join(directory, "package.json"))!.toString("utf8")),
      );
      const names = new Set([
        ...Object.keys(metadata.dependencies ?? {}),
        ...Object.keys(metadata.peerDependencies ?? {}),
        ...Object.keys(metadata.optionalDependencies ?? {}),
      ]);
      for (const name of [...names].sort()) {
        // npm module names, never traversal paths or absolute filesystem names.
        if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
          throw new Error(`Invalid SDK dependency name: ${name}`);
        const dependency = dependencyRoot(directory, name);
        if (!dependency) {
          if (
            metadata.peerDependenciesMeta?.[name]?.optional ||
            metadata.optionalDependencies?.[name]
          )
            continue;
          throw new Error(`Unavailable SDK dependency: ${name}`);
        }
        record.dependencies.set(name, dependency);
        visit(dependency);
      }
    }
    for (const name of modules) put(join(source, name));
    const sdkRoot = packageRoot(sdkEntry);
    visit(sdkRoot);
    const manifest = JSON.stringify({
      files: [...files].map(([path, bytes]) => [path, digest(bytes)]),
      packages: [...packages].map(([path, record]) => [path, [...record.dependencies]]),
      sdkEntry,
    });
    return { source, files, packages, sdkRoot, hash: digest(manifest) };
  }

  return {
    resolve(goalInstanceId: string): GoalExecutionAssets {
      if (disposed || !goalInstanceId) throw new Error("Inactive Goal asset registry");
      const existing = goals.get(goalInstanceId);
      if (existing) {
        verify(existing);
        return existing;
      }
      const captured = capture();
      const generation = randomUUID();
      const destination = join(root, generation);
      mkdirSync(destination);
      try {
        const packagePath = (path: string) =>
          join(destination, "packages", String(captured.packages.get(path)!.index));
        for (const [path, bytes] of captured.files) {
          let output: string;
          if (modules.some((name) => path === join(captured.source, name)))
            output = join(destination, "worker", path.slice(captured.source.length + 1));
          else {
            const parent = [...captured.packages.keys()].find((directory) =>
              path.startsWith(directory + "/"),
            );
            if (!parent) throw new Error("Unmapped SDK asset");
            output = join(packagePath(parent), path.slice(parent.length + 1));
          }
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, bytes, { mode: 0o400 });
          if (digest(readFileSync(output)) !== digest(bytes))
            throw new Error("Goal asset copy differs from captured manifest");
        }
        for (const [path, record] of captured.packages) {
          for (const [name, target] of record.dependencies) {
            const link = join(packagePath(path), "node_modules", name);
            mkdirSync(dirname(link), { recursive: true });
            // Only immutable copies inside this generation; never live node_modules.
            symlinkSync(packagePath(target), link, "dir");
          }
        }
        const workerDirectory = join(destination, "worker");
        const link = join(workerDirectory, "node_modules", "@tanstack", "ai");
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(packagePath(captured.sdkRoot), link, "dir");
        if (capture().hash !== captured.hash)
          throw new Error("Goal asset sources changed during capture");
        const workerUrlString = pathToFileURL(resolve(workerDirectory, modules[0])).href;
        const manifest = JSON.stringify({
          goalInstanceId,
          sourceGeneration: generation,
          canonicalWorkerUrl: workerUrlString,
          tree: snapshotTree(destination),
        });
        writeFileSync(join(destination, manifestName), manifest, { mode: 0o400 });
        const assets = verify({
          goalInstanceId,
          sourceGeneration: generation,
          canonicalWorkerUrl: workerUrlString,
          manifestHash: digest(manifest),
        });
        goals.set(goalInstanceId, assets);
        return assets;
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
    },
    verify,
    /** Cold completed-Goal adoption only: validates saved bytes, never captures replacement code. */
    adopt(saved: SavedGoalExecutionAssets): GoalExecutionAssets {
      const verified = verify(saved);
      const existing = goals.get(saved.goalInstanceId);
      if (existing) {
        if (
          existing.manifestHash !== verified.manifestHash ||
          existing.canonicalWorkerUrl !== verified.canonicalWorkerUrl ||
          existing.sourceGeneration !== verified.sourceGeneration
        )
          throw new Error("Goal asset pin conflict");
        return existing;
      }
      goals.set(verified.goalInstanceId, verified);
      return verified;
    },
    /** Acquire before Worker construction; release only after termination/exit (or boot failure). */
    use(assets: GoalExecutionAssets) {
      if (disposed || goals.get(assets.goalInstanceId) !== assets)
        throw new Error("Unregistered Goal execution assets");
      verify(assets);
      activeLeases++;
      let released = false;
      return Object.freeze({
        assets,
        release(): void {
          if (released) return;
          released = true;
          activeLeases--;
        },
      });
    },
    /** Refuses disposal until every owner-tracked Worker lease has been released. */
    dispose(options: { readonly remove?: boolean } = {}): void {
      if (activeLeases !== 0) throw new Error("Goal asset workers are still active");
      disposed = true;
      goals.clear();
      // Production shutdown retains immutable pins. Explicit removal is for test-owned roots only;
      // this registry never deletes adopted snapshots owned by another registry.
      if (options.remove) rmSync(root, { recursive: true, force: true });
    },
  };
}
