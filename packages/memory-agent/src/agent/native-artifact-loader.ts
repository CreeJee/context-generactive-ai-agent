import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Predicate, Schema } from "effect";
import type * as NativeArtifact from "./native-artifact-entry.ts";

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
  Effect.try({ try: run, catch: (cause) => new NativeArtifactLoadError({ reason, cause }) });

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
    return yield* new NativeArtifactLoadError({
      reason: "trust",
      cause: "Explicit caller trust required",
    });
  const descriptor = yield* Schema.decodeUnknownEffect(NativeArtifactDescriptor)(input).pipe(
    Effect.mapError((cause) => new NativeArtifactLoadError({ reason: "descriptor", cause })),
  );
  const bytes = yield* boundary("path", () => {
    const url = new URL(descriptor.fileUrl);
    if (url.protocol !== "file:" || url.search || url.hash)
      throw new Error("Expected canonical file URL");
    const path = fileURLToPath(url);
    if (pathToFileURL(realpathSync(path)).href !== descriptor.fileUrl)
      throw new Error("Noncanonical or symlink artifact path");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Artifact is not a regular file");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  });
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256)
    return yield* new NativeArtifactLoadError({ reason: "integrity", cause: "SHA256 mismatch" });
  const directory = yield* Effect.acquireRelease(
    boundary("staging", () => {
      const parent = realpathSync(options.ownerControlledDirectory);
      if (parent !== options.ownerControlledDirectory)
        throw new Error("Noncanonical staging parent");
      return mkdtempSync(join(parent, ".verified-native-"));
    }),
    (directory) =>
      boundary("staging", () => rmSync(directory, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  );
  const stagedUrl = yield* boundary("staging", () => {
    const file = join(directory, "artifact.mjs");
    writeFileSync(file, bytes, { flag: "wx", mode: 0o400 });
    return pathToFileURL(file).href;
  });
  // Native import cannot be cancelled. Wait for evaluation to settle before scope removes bytes.
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(/* @vite-ignore */ stagedUrl),
    catch: (cause) => new NativeArtifactLoadError({ reason: "evaluation", cause }),
  }).pipe(Effect.uninterruptible);
  yield* Schema.decodeUnknownEffect(FactoryExports)(module).pipe(
    Effect.mapError((cause) => new NativeArtifactLoadError({ reason: "exports", cause })),
  );
  // SAFETY: ABI checks all four callable exports; signatures/semantics remain caller-trusted.
  return { descriptor, stagedUrl, factories: module as typeof NativeArtifact };
});
