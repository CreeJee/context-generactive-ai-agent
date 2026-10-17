import { HashSet } from "effect";
import { isTruthy } from "../app/truthy.ts";
import { BuildServerConfig, buildConfigAsset } from "../app/.server/build-config.ts";
// Builds the executable for this machine's platform:
//   dist/context-agent-<platform>-<arch>/context-agent (+ .sha256)
// Run with `vp run package`, which builds the app and its workspace dependencies first. Other platforms are built on
// their own machines (turbovec and the optional platform packages exist only for the host).
// The runtime manifest is hashed incrementally because staged native assets can be large.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  MutableHashMap,
  Option,
  Redacted,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Hex } from "effect/encoding";
import { build } from "vite-plus/pack";

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  args: Schema.String,
}) {}

class PackagePreflightFailed extends Schema.TaggedError<PackagePreflightFailed>()(
  "PackagePreflightFailed",
  { message: Schema.String },
) {}

const program = Effect.gen(function* () {
  const services = yield* Layer.build(NodeServices.layer);
  const fs = Context.get(services, FileSystem.FileSystem);
  const path = Context.get(services, Path.Path);
  const crypto = Context.get(services, Crypto.Crypto);
  const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
  const { basename, dirname, join, relative, sep } = path;
  const app = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const repo = join(app, "..", "..");
  const memoryAgent = join(repo, "packages", "memory-agent");
  const target = `${process.platform}-${process.arch}`;
  // Collected under build/ because `vp pack` empties dist/ before it writes.
  const work = join(app, "build", "package");
  const stage = join(work, "runtime");
  const assetsFile = join(work, "sea-assets.json");
  // `vp pack` cleans dist/ while it builds. Create the executable outside dist/ and
  // publish it only after packing finishes so the clean step cannot remove its directory.
  const packedOutput = join(work, `context-agent-${target}`);
  const output = join(app, "dist", `context-agent-${target}`);

  const PackageJson = Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  });
  const RuntimeArtifactManifest = Schema.Struct({
    version: Schema.Literal(1),
    native: Schema.Struct({
      file: Schema.Literal("native.mjs"),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      sourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      contractVersion: Schema.Literal("native-factories/v1"),
    }),
    worker: Schema.Struct({
      file: Schema.Literal("full-loop-worker.mjs"),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  });
  const readPackage = Effect.fn("package.readPackage")(function* (directory: string) {
    return yield* Schema.decodeEffect(Schema.fromJsonString(PackageJson))(
      yield* fs.readFileString(join(directory, "package.json")),
    );
  });

  const ReleaseVersion = Schema.String.pipe(
    Schema.check(
      Schema.isPattern(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    ),
  );
  const suppliedVersion = Option.getOrUndefined(
    yield* Config.option(Config.String("CONTEXT_AGENT_VERSION")),
  );
  const releaseVersion = yield* Schema.decodeEffect(ReleaseVersion)(
    (suppliedVersion ?? (yield* readPackage(repo)).version).replace(/^v/, ""),
  );
  const releaseChannel = yield* Config.Literals(
    ["stable", "prerelease"],
    "CONTEXT_AGENT_RELEASE_CHANNEL",
  ).pipe(
    Config.withDefault(
      isTruthy(suppliedVersion) && !releaseVersion.includes("-") ? "stable" : "prerelease",
    ),
  );
  const run = Effect.fn("package.run")(function* (
    command: string,
    args: readonly string[],
    env: Record<string, string> = {},
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd: app,
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: true,
        shell: process.platform === "win32",
      }),
    );
    if (Number(yield* child.exitCode) !== 0)
      return yield* CommandFailed.make({ command, args: args.join(" ") });
  });

  const toPosix = (path: string) => path.split(sep).join("/");

  /** Node's lookup from `fromDirectory` for an installed package, as its real directory. */
  const findPackage = Effect.fn("package.findPackage")(function* (
    fromDirectory: string,
    name: string,
  ) {
    for (
      let directory = fromDirectory;
      directory !== dirname(directory);
      directory = dirname(directory)
    ) {
      const candidate =
        basename(directory) === "node_modules"
          ? join(directory, name)
          : join(directory, "node_modules", name);
      if (yield* fs.exists(join(candidate, "package.json"))) return yield* fs.realPath(candidate);
    }
    return null;
  });

  /** Files a package needs at run time; null keeps everything except nested node_modules. */
  function keptFiles(name: string): HashSet.HashSet<string> | null {
    switch (name) {
      case "turbovec":
        return HashSet.fromIterable([
          "package.json",
          "index.js",
          "index.d.ts",
          "memory-turbovec.node",
        ]);
      case "@huggingface/transformers":
        // memory-agent `require`s it: the Node CommonJS build is the only file used.
        return HashSet.fromIterable(["package.json", "dist", "dist/transformers.node.cjs"]);
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
  const collectPackages = Effect.fn("package.collectPackages")(function* () {
    const placed = MutableHashMap.empty<string, string>();
    const topLevel = MutableHashMap.empty<string, string>();
    const place = Effect.fn("package.place")(function* (
      realDirectory: string,
      name: string,
      parentTarget: string,
    ): Effect.fn.Return<void, PlatformError | import("effect/Schema").SchemaError> {
      if (MutableHashMap.has(placed, realDirectory)) return;
      const conflict =
        MutableHashMap.has(topLevel, name) &&
        Option.getOrUndefined(MutableHashMap.get(topLevel, name)) !== realDirectory;
      const destination = conflict
        ? join(parentTarget, "node_modules", name)
        : join(stage, "node_modules", name);
      if (!conflict) MutableHashMap.set(topLevel, name, realDirectory);
      MutableHashMap.set(placed, realDirectory, destination);
      const kept = keptFiles(name);
      yield* copyPackage(realDirectory, destination, realDirectory, kept);
      const manifest = yield* readPackage(realDirectory);
      for (const dependency of [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]) {
        if (skipDependency(name, dependency)) continue;
        // Optional platform packages for other machines are not installed and are skipped here.
        const found = yield* findPackage(realDirectory, dependency);
        if (isTruthy(found)) yield* place(found, dependency, destination);
      }
    });
    for (const root of [
      "turbovec",
      "@napi-rs/keyring",
      "@huggingface/transformers",
      "sharp",
      "kiwi-nlp",
      // Finds its helper binaries (seccomp, Windows helper, JVM proxy agent) next to its own files.
      "@anthropic-ai/sandbox-runtime",
      // Full-loop Goal workers import their own file-backed SDK, not the owner's bundle.
      "@tanstack/ai",
      "effect",
      // Native factories share the owner's Effect and platform services rather than bundling duplicates.
      "@effect/platform-node",
    ]) {
      const found = yield* findPackage(memoryAgent, root);
      if (!isTruthy(found))
        return yield* PackagePreflightFailed.make({
          message: `${root} is not installed; run vp install`,
        });
      yield* place(found, root, stage);
    }

    // onnxruntime ships every platform's binaries; keep this machine's.
    const binaries = join(stage, "node_modules", "onnxruntime-node", "bin", "napi-v6");
    for (const platform of yield* fs.readDirectory(binaries)) {
      if (platform !== process.platform)
        yield* fs.remove(join(binaries, platform), { recursive: true });
      else
        for (const arch of yield* fs.readDirectory(join(binaries, platform)))
          if (arch !== process.arch)
            yield* fs.remove(join(binaries, platform, arch), { recursive: true });
    }
  });

  /**
   * Native files the executable cannot run without. Most come with this machine's optional
   * packages; turbovec's addon is built locally and is not in the repository, so a fresh clone must
   * build it first. A missing file stops packaging instead of shipping a broken executable.
   */
  const verifyNativeFiles = Effect.fn("package.verifyNativeFiles")(function* () {
    const underStage = (path: string) => join(stage, "node_modules", path);
    const hasNodeAddon = Effect.fnUntraced(function* (directory: string) {
      return (
        (yield* fs.exists(underStage(directory))) &&
        (yield* listFiles(underStage(directory))).some((file) => file.endsWith(".node"))
      );
    });
    const checks = [
      {
        ok: yield* fs.exists(underStage("turbovec/memory-turbovec.node")),
        fix: "turbovec addon missing: run `vp run build`, which builds packages/turbovec (needs Rust; on Windows also the MSVC build tools)",
      },
      {
        ok: yield* fs.exists(
          underStage(
            `onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`,
          ),
        ),
        fix: `onnxruntime-node has no binary for ${target}: run vp install on this machine`,
      },
      {
        ok: yield* hasNodeAddon("@napi-rs"),
        fix: `@napi-rs/keyring has no binary for ${target}: run vp install on this machine`,
      },
      {
        ok: yield* hasNodeAddon("@img"),
        fix: `sharp has no binary for ${target}: run vp install on this machine`,
      },
      {
        ok: yield* fs.exists(underStage("kiwi-nlp/dist/kiwi-wasm.wasm")),
        fix: "kiwi-nlp wasm missing: run vp install",
      },
    ];
    const missing = checks.filter((check) => !check.ok).map((check) => check.fix);
    if (missing.length > 0)
      return yield* PackagePreflightFailed.make({
        message: `cannot package:\n- ${missing.join("\n- ")}`,
      });
  });

  /**
   * Signs the executable on macOS.
   *
   * `postject` rewrites the Mach-O to add the SEA blob, which breaks whatever signature Node shipped
   * with, so it is signed here afterwards. The hardened runtime and `entitlements.plist` are applied
   * either way: notarization requires them, and using them locally too means a signed build behaves
   * like the one that ships.
   *
   * With `CONTEXT_AGENT_SIGN_IDENTITY` (a "Developer ID Application: …" identity in the keychain) the
   * result can be notarized by `scripts/notarize-macos.ts`. Without it the signature is ad-hoc, which
   * runs on this machine but shows Gatekeeper's "cannot be verified" warning anywhere else.
   */
  const signMacos = Effect.fn("package.signMacos")(function* (executable: string) {
    const identity = Option.getOrUndefined(
      yield* Config.option(Config.String("CONTEXT_AGENT_SIGN_IDENTITY")),
    );
    yield* run("codesign", [
      "--sign",
      identity ?? "-",
      "--force",
      // Notarization requires a secure timestamp; an ad-hoc signature cannot carry one.
      ...(isTruthy(identity) ? ["--timestamp"] : []),
      "--options",
      "runtime",
      "--entitlements",
      join(app, "entitlements.plist"),
      executable,
    ]);
    yield* run("codesign", ["--verify", "--strict", "--verbose=2", executable]);
    yield* Effect.logInfo(
      isTruthy(identity) ? `signed with ${identity}` : "signed ad-hoc (not distributable)",
    );
  });

  const listFiles = Effect.fn("package.listFiles")(function* (
    directory: string,
  ): Effect.fn.Return<string[], PlatformError> {
    const files: string[] = [];
    for (const name of yield* fs.readDirectory(directory)) {
      const full = join(directory, name);
      // The manifest excludes links as Dirent listing did, but FileSystem.stat follows them:
      // readLink succeeds only for a link and fails with the unmapped `Unknown` reason (EINVAL) for
      // anything else, which stat then classifies. The staged tree is this script's own output.
      const type = yield* fs.readLink(full).pipe(
        Effect.as("SymbolicLink" as const),
        Effect.catchReason("PlatformError", "Unknown", () =>
          Effect.map(fs.stat(full), (info) => info.type),
        ),
      );
      switch (type) {
        case "Directory":
          files.push(...(yield* listFiles(full)));
          break;
        case "File":
          files.push(full);
          break;
      }
    }
    return files;
  });
  const copyPackage = Effect.fn("package.copyPackage")(function* (
    source: string,
    destination: string,
    root: string,
    kept: HashSet.HashSet<string> | null,
  ): Effect.fn.Return<void, PlatformError> {
    const item = toPosix(relative(root, source));
    if (
      item.split("/").includes("node_modules") ||
      (item !== "" && kept !== null && !HashSet.has(kept, item))
    )
      return;
    const entry = yield* fs.stat(source);
    switch (entry.type) {
      case "Directory":
        yield* fs.makeDirectory(destination, { recursive: true, mode: entry.mode });
        for (const name of yield* fs.readDirectory(source))
          yield* copyPackage(join(source, name), join(destination, name), root, kept);
        break;
      case "File":
        yield* fs.copyFile(source, destination);
        break;
    }
  });

  if (!(yield* fs.exists(join(app, "build", "client"))))
    return yield* PackagePreflightFailed.make({
      message: "build/client is missing; run `vp run package` (it builds first)",
    });

  yield* fs.remove(work, { recursive: true, force: true });
  yield* fs.makeDirectory(stage, { recursive: true });
  yield* fs.copy(join(app, "build", "client"), join(stage, "client"));
  // Worker scripts; `runtimeWorker()` looks for them next to the runtime files.
  const workerScripts = {
    "kiwi-worker.ts": "morph",
    "embed-worker.ts": "embedding",
  } as const;
  for (const [file, folder] of Object.entries(workerScripts))
    yield* fs.copy(join(memoryAgent, "src", "memory", folder, file), join(stage, file));
  // Goal worker and native factory artifacts are produced by memory-agent's dependency build.
  // Packaging only verifies/copies these bytes; it never compiles them at startup or on first use.
  const prebuiltRuntime = join(memoryAgent, "dist", "runtime");
  const artifactManifestPath = join(prebuiltRuntime, "artifact-manifest.json");
  if (!(yield* fs.exists(artifactManifestPath)))
    return yield* PackagePreflightFailed.make({
      message: `${relative(repo, artifactManifestPath)} is missing; run \`vp run build\` first`,
    });
  const artifactManifest = yield* Schema.decodeEffect(
    Schema.fromJsonString(RuntimeArtifactManifest),
  )(yield* fs.readFileString(artifactManifestPath));
  for (const artifact of [artifactManifest.native, artifactManifest.worker]) {
    const source = join(prebuiltRuntime, artifact.file);
    if (!(yield* fs.exists(source)))
      return yield* PackagePreflightFailed.make({
        message: `${relative(repo, source)} is missing; run \`vp run build\` first`,
      });
    const actual = Hex.encode(yield* crypto.digest("SHA-256", yield* fs.readFile(source)));
    if (actual !== artifact.sha256)
      return yield* PackagePreflightFailed.make({
        message: `${relative(repo, source)} does not match artifact-manifest.json`,
      });
    yield* fs.copy(source, join(stage, artifact.file));
  }
  yield* fs.copy(artifactManifestPath, join(stage, "artifact-manifest.json"));
  // The import and redaction workers are TypeScript with their own dependencies (Effect, secretlint),
  // so each is bundled into one file instead; a checkout runs the source.
  const bundledWorkers = {
    "import-worker": join(memoryAgent, "src", "imports", "worker.ts"),
    "redact-worker": join(memoryAgent, "src", "secrets", "redact-worker.ts"),
    "native-search-worker": join(memoryAgent, "src", "memory", "native-search", "worker.ts"),
    "sandbox-worker": join(memoryAgent, "src", "shell", "sandbox-worker.ts"),
  } as const;
  for (const [name, source] of Object.entries(bundledWorkers))
    yield* Effect.tryPromise(() =>
      build({
        config: false,
        entry: { [name]: source },
        outDir: stage,
        clean: false,
        format: "esm",
        platform: "node",
        fixedExtension: true,
        dts: false,
        deps: { alwaysBundle: [/.*/], onlyBundle: false },
        outputOptions: { codeSplitting: false },
        report: false,
        logLevel: "warn",
      }),
    );
  // The app's own skills; `builtinSkillsDirectory()` looks for them next to the runtime files.
  yield* fs.copy(join(memoryAgent, "skills"), join(stage, "skills"));
  yield* collectPackages();
  yield* verifyNativeFiles();

  // Asset names and manifest entries use `/` on every platform; the executable joins them itself.
  const files = (yield* listFiles(stage)).map((file) => toPosix(relative(stage, file))).sort();
  // One digest per file, then a digest of the names and digests: no file is held past its turn.
  const entries: string[] = [];
  let bytes = 0;
  const assets: Record<string, string> = {};
  for (const file of files) {
    const content = yield* fs.readFile(join(stage, file));
    entries.push(`${file}\0${Hex.encode(yield* crypto.digest("SHA-256", content))}`);
    bytes += content.length;
    assets[`runtime/files/${file}`] = join(stage, file);
  }
  const hash = Hex.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(entries.join("\n"))),
  );
  const manifestFile = join(work, "runtime-manifest.json");
  yield* fs.writeFileString(
    manifestFile,
    yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({ hash: Schema.String, files: Schema.Array(Schema.String) }),
      ),
    )({ hash: hash.slice(0, 16), files }),
  );
  assets["runtime/manifest.json"] = manifestFile;
  const releaseInfoFile = join(work, "release-info.json");
  yield* fs.writeFileString(
    releaseInfoFile,
    yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          version: Schema.String,
          channel: Schema.Literals(["stable", "prerelease"]),
          target: Schema.String,
        }),
      ),
    )({ version: releaseVersion, channel: releaseChannel, target }),
  );
  assets["release/info.json"] = releaseInfoFile;
  // The developer's report webhook from the build environment (a release secret in CI). It is never
  // printed; the server resolves it through Config behind the runtime environment.
  const developerWebhook = yield* Config.option(Config.Redacted("DISCORD_WEBHOOK_URL"));
  const buildConfigJson = yield* Schema.encodeEffect(Schema.fromJsonString(BuildServerConfig))(
    Option.match(developerWebhook, {
      onNone: () => ({}),
      onSome: (url) => ({ DISCORD_WEBHOOK_URL: Redacted.value(url) }),
    }),
  );
  // The executable carries the webhook; no plaintext copy outlives packaging, even on failure.
  assets[buildConfigAsset] = yield* Effect.acquireRelease(
    fs
      .writeFileString(join(work, "server-config.json"), buildConfigJson, { mode: 0o600 })
      .pipe(Effect.as(join(work, "server-config.json"))),
    (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
  );
  yield* fs.writeFileString(
    assetsFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
      assets,
    ),
  );
  yield* Effect.logInfo(
    `runtime: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB; release: ${releaseVersion} (${releaseChannel}, ${target}); developer webhook: ${Option.isSome(developerWebhook) ? "embedded" : "not set"}`,
  );

  yield* fs.remove(packedOutput, { recursive: true, force: true });
  yield* fs.makeDirectory(packedOutput, { recursive: true });
  yield* run("vp", ["pack"], {
    CONTEXT_AGENT_EXE_ASSETS: assetsFile,
    CONTEXT_AGENT_EXE_DIR: packedOutput,
  });
  yield* fs.remove(output, { recursive: true, force: true });
  yield* fs.copy(packedOutput, output);

  const executable = join(
    output,
    process.platform === "win32" ? "context-agent.exe" : "context-agent",
  );
  if (process.platform === "darwin") yield* signMacos(executable);
  const digest = Hex.encode(yield* crypto.digest("SHA-256", yield* fs.readFile(executable)));
  yield* fs.writeFileString(`${executable}.sha256`, `${digest}  ${basename(executable)}\n`);
  yield* Effect.logInfo(
    `${relative(app, executable)}: ${(Number((yield* fs.stat(executable)).size) / 1e6).toFixed(1)} MB`,
  );
});
await Effect.runPromise(Effect.scoped(program));
