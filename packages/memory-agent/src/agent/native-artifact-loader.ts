import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { fileURLToPath, pathToFileURL } from "node:url";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem, ManagedRuntime, Option, Predicate, Schema } from "effect";
import type * as NativeArtifact from "./native-artifact-entry.ts";

// Stateless official host service; acquisitions below attach cleanup to caller Scope.
const filesystemRuntime = ManagedRuntime.make(NodeFileSystem.layer);
const fs = filesystemRuntime.runSync(FileSystem.FileSystem);
const stagingError = (cause: import("effect/PlatformError").PlatformError) =>
  NativeArtifactLoadError.make({ reason: "staging", cause });
const pathError = (cause: unknown) => NativeArtifactLoadError.make({ reason: "path", cause });

/** Reads a regular file whole through one handle that refuses a linked leaf where the OS can. */
const readRegularFile = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { noFollow: process.platform !== "win32" });
      if ((yield* file.stat).type !== "File")
        return yield* pathError("Artifact is not a regular file");
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = yield* file.readAlloc(64 * 1024);
        if (Option.isNone(chunk)) return Buffer.concat(chunks);
        chunks.push(chunk.value);
      }
    }),
  ).pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(pathError(cause))));

/** Loader ABI, not a version claim about the entry module or its transitive dependencies. */
export const nativeFactoryLoaderContract = "native-factories/v1";
export const NativeArtifactDescriptor = Schema.Struct({
  fileUrl: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  contractVersion: Schema.Literal(nativeFactoryLoaderContract),
});
export type NativeArtifactDescriptor = typeof NativeArtifactDescriptor.Type;

export class NativeArtifactLoadError extends Schema.TaggedError<NativeArtifactLoadError>()(
  "NativeArtifactLoadError",
  {
    reason: Schema.Literals([
      "trust",
      "descriptor",
      "path",
      "integrity",
      "staging",
      "evaluation",
      "exports",
    ]),
    cause: Schema.Defect(),
  },
) {}

const boundary = <A>(reason: NativeArtifactLoadError["reason"], run: () => A) =>
  Effect.try({ try: run, catch: (cause) => NativeArtifactLoadError.make({ reason, cause }) });

const FactoryExports = Schema.Struct({
  makeRecordingMiddleware: Schema.declare(Predicate.isFunction),
  makePermissionGateMiddleware: Schema.declare(Predicate.isFunction),
  createMemoryTools: Schema.declare(Predicate.isFunction),
  createSubscriptionRuntimeImplementation: Schema.declare(Predicate.isFunction),
});

/**
 * Low-level opt-in loader; owner registration supplies trust for generated artifacts.
 * This loader alone never authorizes Goal adoption or registers external descriptors.
 * The caller must explicitly trust executable code AND own a private staging parent under
 * the host package's dependency-resolution tree. A digest is integrity, not authorization.
 * Only single-file bundles with bare/node imports are supported: relative assets/imports
 * are not relocated or pinned. Neither dependencies nor the whole Goal are frozen.
 * Each acquisition has a unique module URL (no cross-acquisition cache reuse). Scope cleanup
 * removes disk staging, not Node's module cache or arbitrary module-created resources.
 * Keep factories within the scope; a fresh process is required for full module unloading.
 */
export const loadTrustedNativeArtifact = Effect.fn("loadTrustedNativeArtifact")(function* (
  // I/O boundary: saved descriptors are decoded immediately below.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  input: unknown,
  options: { readonly explicitlyTrusted: boolean; readonly ownerControlledDirectory: string },
) {
  if (options.explicitlyTrusted !== true)
    return yield* NativeArtifactLoadError.make({
      reason: "trust",
      cause: "Explicit caller trust required",
    });
  const descriptor = yield* Schema.decodeUnknownEffect(NativeArtifactDescriptor)(input).pipe(
    Effect.mapError((cause) => NativeArtifactLoadError.make({ reason: "descriptor", cause })),
  );
  const url = yield* boundary("path", () => new URL(descriptor.fileUrl));
  if (url.protocol !== "file:" || url.search.length > 0 || url.hash.length > 0)
    return yield* pathError("Expected canonical file URL");
  const path = yield* boundary("path", () => fileURLToPath(url));
  const canonical = yield* fs.realPath(path).pipe(Effect.mapError(pathError));
  if (pathToFileURL(canonical).href !== descriptor.fileUrl)
    return yield* pathError("Noncanonical or symlink artifact path");
  const bytes = yield* readRegularFile(path);
  if (hashSha256(bytes) !== descriptor.sha256)
    return yield* NativeArtifactLoadError.make({ reason: "integrity", cause: "SHA256 mismatch" });
  const parent = yield* fs
    .realPath(options.ownerControlledDirectory)
    .pipe(Effect.mapError(stagingError));
  if (parent !== options.ownerControlledDirectory)
    return yield* NativeArtifactLoadError.make({
      reason: "staging",
      cause: "Noncanonical staging parent",
    });
  const directory = yield* Effect.acquireRelease(
    fs
      .makeTempDirectory({ directory: parent, prefix: ".verified-native-" })
      .pipe(Effect.mapError(stagingError)),
    (directory) =>
      fs
        .remove(directory, { recursive: true, force: true })
        .pipe(Effect.mapError(stagingError), Effect.orDie),
  );
  const file = join(directory, "artifact.mjs");
  yield* fs.writeFile(file, bytes, { flag: "wx", mode: 0o400 }).pipe(Effect.mapError(stagingError));
  const stagedUrl = pathToFileURL(file).href;
  // Native import cannot be cancelled. Wait for evaluation to settle before scope removes bytes.
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(/* @vite-ignore */ stagedUrl),
    catch: (cause) => NativeArtifactLoadError.make({ reason: "evaluation", cause }),
  }).pipe(Effect.uninterruptible);
  yield* Schema.decodeUnknownEffect(FactoryExports)(module).pipe(
    Effect.mapError((cause) => NativeArtifactLoadError.make({ reason: "exports", cause })),
  );
  // SAFETY: ABI checks all four callable exports; signatures/semantics remain caller-trusted.
  return { descriptor, stagedUrl, factories: module as typeof NativeArtifact };
});
