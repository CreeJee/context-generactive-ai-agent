// Builds the executable for this machine's platform:
//   dist/context-agent-<platform>-<arch>/context-agent (+ .sha256)
// Run with `vp run package`, which runs `react-router build` first. Other platforms are built on
// their own machines (turbovec and the optional platform packages exist only for the host).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const app = fileURLToPath(new URL("..", import.meta.url));
const repo = join(app, "..", "..");
const memoryAgent = join(repo, "packages", "memory-agent");
const target = `${process.platform}-${process.arch}`;
// Collected under build/ because `vp pack` empties dist/ before it writes.
const work = join(app, "build", "package");
const stage = join(work, "runtime");
const assetsFile = join(work, "sea-assets.json");
const output = join(app, "dist", `context-agent-${target}`);

const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  optionalDependencies: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
const readPackage = (directory: string) =>
  Schema.decodeUnknownSync(Schema.parseJson(PackageJson))(
    readFileSync(join(directory, "package.json"), "utf8"),
  );

function run(command: string, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd: app,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

/** Node's lookup from `fromDirectory` for an installed package, as its real directory. */
function findPackage(fromDirectory: string, name: string) {
  for (
    let directory = fromDirectory;
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    const candidate =
      basename(directory) === "node_modules"
        ? join(directory, name)
        : join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  return null;
}

/** Files a package needs at run time; null keeps everything except nested node_modules. */
function keptFiles(name: string): ReadonlySet<string> | null {
  switch (name) {
    case "turbovec":
      return new Set(["package.json", "index.js", "index.d.ts", "memory-turbovec.node"]);
    case "@huggingface/transformers":
      // memory-agent `require`s it: the Node CommonJS build is the only file used.
      return new Set(["package.json", "dist", "dist/transformers.node.cjs"]);
    default:
      return null;
  }
}

/** Dependencies not needed at run time: bundled into transformers' build, or install scripts only. */
function skipDependency(dependent: string, dependency: string) {
  if (dependent === "@huggingface/transformers")
    return ["onnxruntime-web", "@huggingface/jinja", "@huggingface/tokenizers"].includes(
      dependency,
    );
  if (dependent === "onnxruntime-node") return dependency !== "onnxruntime-common";
  return false;
}

/** Copies the runtime-loaded packages and their dependencies into `<stage>/node_modules`. */
function collectPackages() {
  const placed = new Map<string, string>();
  const topLevel = new Map<string, string>();
  const place = (realDirectory: string, name: string, parentTarget: string) => {
    if (placed.has(realDirectory)) return;
    const conflict = topLevel.has(name) && topLevel.get(name) !== realDirectory;
    const destination = conflict
      ? join(parentTarget, "node_modules", name)
      : join(stage, "node_modules", name);
    if (!conflict) topLevel.set(name, realDirectory);
    placed.set(realDirectory, destination);
    const kept = keptFiles(name);
    cpSync(realDirectory, destination, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const path = relative(realDirectory, source);
        if (path === "") return true;
        if (path.split("/").includes("node_modules")) return false;
        return kept === null || kept.has(path);
      },
    });
    const manifest = readPackage(realDirectory);
    for (const dependency of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      if (skipDependency(name, dependency)) continue;
      // Optional platform packages for other machines are not installed and are skipped here.
      const found = findPackage(realDirectory, dependency);
      if (found) place(found, dependency, destination);
    }
  };
  for (const root of ["turbovec", "@napi-rs/keyring", "@huggingface/transformers", "kiwi-nlp"]) {
    const found = findPackage(memoryAgent, root);
    if (!found) throw new Error(`${root} is not installed; run vp install`);
    place(found, root, stage);
  }

  // onnxruntime ships every platform's binaries; keep this machine's.
  const binaries = join(stage, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  for (const platform of readdirSync(binaries)) {
    if (platform !== process.platform) rmSync(join(binaries, platform), { recursive: true });
    else
      for (const arch of readdirSync(join(binaries, platform)))
        if (arch !== process.arch) rmSync(join(binaries, platform, arch), { recursive: true });
  }
}

/** Platforms `@openai/codex` publishes a binary for, and the Rust target triple inside each. */
const CodexTarget = Schema.Literal(
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
);
const codexTriples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
} satisfies Record<typeof CodexTarget.Type, string>;

/** The pinned codex platform package the executable downloads on first need. */
function writeCodexManifest() {
  const codex = findPackage(memoryAgent, "@openai/codex");
  if (!codex) throw new Error("@openai/codex is not installed; run vp install");
  const { version } = readPackage(codex);
  if (!Schema.is(CodexTarget)(target)) throw new Error(`codex has no binary for ${target}`);
  const triple = codexTriples[target];
  const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
  const entry = new RegExp(
    `'@openai/codex@${version.replaceAll(".", "\\.")}-${target}':\\s*\\n\\s*resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
  ).exec(lock);
  if (!entry?.[1]) throw new Error(`no lockfile integrity for @openai/codex@${version}-${target}`);
  writeFileSync(
    join(stage, "codex.json"),
    JSON.stringify({
      version,
      triple,
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${target}.tgz`,
      integrity: entry[1],
    }),
  );
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return entry.isFile() ? [full] : [];
  });
}

if (!existsSync(join(app, "build", "client")))
  throw new Error("build/client is missing; run `vp run package` (it builds first)");

rmSync(work, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(app, "build", "client"), join(stage, "client"), { recursive: true });
cpSync(
  join(memoryAgent, "src", "memory", "morph", "kiwi-worker.mjs"),
  join(stage, "kiwi-worker.mjs"),
);
collectPackages();
writeCodexManifest();

const files = listFiles(stage)
  .map((file) => relative(stage, file))
  .sort();
const hash = createHash("sha256");
let bytes = 0;
const assets: Record<string, string> = {};
for (const file of files) {
  const content = readFileSync(join(stage, file));
  hash.update(file).update("\0").update(content);
  bytes += content.length;
  assets[`runtime/files/${file}`] = join(stage, file);
}
const manifestFile = join(work, "runtime-manifest.json");
writeFileSync(manifestFile, JSON.stringify({ hash: hash.digest("hex").slice(0, 16), files }));
assets["runtime/manifest.json"] = manifestFile;
writeFileSync(assetsFile, JSON.stringify(assets));
console.log(`runtime: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);

rmSync(output, { recursive: true, force: true });
run("vp", ["pack"], { CONTEXT_AGENT_EXE_ASSETS: assetsFile, CONTEXT_AGENT_EXE_DIR: output });

const executable = join(
  output,
  process.platform === "win32" ? "context-agent.exe" : "context-agent",
);
if (process.platform === "darwin") {
  const verified = spawnSync("codesign", ["--verify", executable]);
  if (verified.status !== 0) run("codesign", ["--sign", "-", "--force", executable]);
}
const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
writeFileSync(`${executable}.sha256`, `${digest}  ${basename(executable)}\n`);
console.log(`${relative(app, executable)}: ${(statSync(executable).size / 1e6).toFixed(1)} MB`);
