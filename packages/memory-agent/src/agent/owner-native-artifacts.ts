import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node filesystem and SQLite contracts.
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { dirname, join } = platformPath;
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { DateTime, Clock, Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { OwnerNativeBuild } from "./owner-native-build.ts";
import { OwnerNativeFiles } from "./owner-native-files.ts";
import { NativeRegistrationError } from "./owner-native-error.ts";
export { NativeRegistrationError } from "./owner-native-error.ts";
import {
  loadTrustedNativeArtifact,
  nativeFactoryLoaderContract,
} from "./native-artifact-loader.ts";

const nativeDigest = (bytes: Uint8Array | string) => hashSha256(bytes);
const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ArtifactManifest = Schema.Struct({
  version: Schema.Literal(1),
  native: Schema.Struct({
    file: Schema.Literal("native.mjs"),
    sha256,
    sourceHash: sha256,
    contractVersion: Schema.Literal(nativeFactoryLoaderContract),
  }),
  worker: Schema.Struct({ file: Schema.Literal("full-loop-worker.mjs"), sha256 }),
});
type ArtifactManifest = typeof ArtifactManifest.Type;

const Registration = Schema.Struct({
  fileUrl: Schema.String,
  sha256,
  contractVersion: Schema.Literal(nativeFactoryLoaderContract),
  sourceHash: sha256,
});
type Registration = typeof Registration.Type;

const boundary = <A>(work: () => A) =>
  Effect.try({ try: work, catch: (cause) => NativeRegistrationError.make({ cause }) });

const loadManifest = Effect.fn("OwnerNativeArtifacts.loadManifest")(function* (
  manifestPath: string,
  files: OwnerNativeFiles["Service"],
) {
  const realManifest = yield* files.realpath(manifestPath);
  const directory = dirname(realManifest);
  const decoded: ArtifactManifest = yield* files.read(realManifest).pipe(
    Effect.flatMap((bytes) =>
      Schema.decodeEffect(Schema.fromJsonString(ArtifactManifest))(new TextDecoder().decode(bytes)),
    ),
    Effect.mapError((cause) => NativeRegistrationError.make({ cause })),
  );
  const nativePath = yield* files.realpath(join(directory, decoded.native.file));
  const workerPath = yield* files.realpath(join(directory, decoded.worker.file));
  yield* boundary(() => {
    if (dirname(nativePath) !== directory || dirname(workerPath) !== directory)
      throw new Error("Artifact escaped its build directory");
  });
  const [nativeBytes, workerBytes] = yield* Effect.all(
    [files.read(nativePath), files.read(workerPath)],
    { concurrency: 2 },
  );
  yield* boundary(() => {
    if (nativeDigest(nativeBytes) !== decoded.native.sha256)
      throw new Error("Native artifact SHA256 mismatch");
    if (nativeDigest(workerBytes) !== decoded.worker.sha256)
      throw new Error("Worker artifact SHA256 mismatch");
  });
  return {
    manifest: decoded,
    nativePath,
    workerPath,
    registration: {
      fileUrl: pathToFileURL(nativePath).href,
      sha256: decoded.native.sha256,
      contractVersion: decoded.native.contractVersion,
      sourceHash: decoded.native.sourceHash,
    } satisfies Registration,
  };
});
type PrebuiltArtifacts = Effect.Success<ReturnType<typeof loadManifest>>;

export class OwnerNativeArtifacts extends Context.Service<
  OwnerNativeArtifacts,
  ReturnType<typeof makeOwnerNativeArtifacts>
>()("memory-agent/agent/owner-native-artifacts/OwnerNativeArtifacts") {
  static readonly layer = Layer.effect(
    OwnerNativeArtifacts,
    Effect.gen(function* () {
      const database = yield* Database;
      const storage = yield* StorageRoot;
      const buildInput = yield* OwnerNativeBuild;
      const files = yield* OwnerNativeFiles;
      const prebuilt = yield* loadManifest(buildInput.manifest, files);
      return makeOwnerNativeArtifacts({
        ...database,
        files,
        prebuilt,
        directory: join(storage.path, "native-artifacts"),
      });
    }),
  ).pipe(Layer.provide(OwnerNativeFiles.layer));
}

/** Private owner boundary: only the build-produced descriptor may be registered.
 * Existing records are revalidated on every acquisition; runtime compilation and source fallback
 * do not exist on this path.
 */
export function makeOwnerNativeArtifacts(owner: {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
  readonly directory: string;
  readonly files?: OwnerNativeFiles["Service"];
  readonly prebuilt?: PrebuiltArtifacts;
  readonly manifest?: string;
}) {
  const files = owner.files ?? OwnerNativeFiles.production;
  const read = owner.sqlite.prepare(`SELECT artifact_url AS fileUrl, artifact_hash AS sha256,
    contract_version AS contractVersion, source_hash AS sourceHash
    FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?`);
  const historic = owner.sqlite.prepare(`SELECT 1 FROM workflow_goal_worker_generations
    WHERE goal_instance_id = ? UNION ALL SELECT 1 FROM workflow_run_bindings WHERE goal_instance_id = ? LIMIT 1`);
  const insert = owner.sqlite.prepare(`INSERT INTO workflow_goal_native_artifacts
    VALUES (?, ?, ?, ?, ?, ?)`);
  const acquire = Effect.fn("OwnerNativeArtifacts.acquire")(function* (goalInstanceId: string) {
    const effectClock = yield* Clock.Clock;
    const saved = yield* boundary(() =>
      EffectFunction.flow(
        Schema.decodeUnknownResult(Schema.UndefinedOr(Registration)),
        Result.getOrThrow,
      )(read.get(goalInstanceId)),
    );
    const durable = yield* files.parent(owner.directory);
    // Evaluation is staged beside the packaged/checkout runtime so allowlisted bare imports resolve
    // to that runtime's node_modules, while the immutable source remains in durable owner storage.
    const evaluation = yield* files.parent(dirname(OwnerNativeBuild.production.manifest));
    if (isTruthy(saved)) {
      const loaded = yield* loadTrustedNativeArtifact(saved, {
        explicitlyTrusted: true,
        ownerControlledDirectory: evaluation,
      });
      return loaded.factories;
    }
    yield* boundary(() => {
      if (isTruthy(historic.get(goalInstanceId, goalInstanceId)))
        throw new Error("Historical Goal has no native provenance; backfill refused");
    });
    const prebuilt =
      owner.prebuilt ??
      (yield* loadManifest(owner.manifest ?? OwnerNativeBuild.production.manifest, files));
    const durablePath = yield* files.publish(
      prebuilt.nativePath,
      join(durable, nativeDigest(goalInstanceId), prebuilt.registration.sha256, "native.mjs"),
    );
    const verified: Registration = {
      ...prebuilt.registration,
      fileUrl: pathToFileURL(durablePath).href,
    };
    yield* boundary(() => files.verifyAtFence(durablePath, durablePath, verified.sha256));
    yield* Effect.uninterruptible(
      boundary(() =>
        owner.atomic(() => {
          files.verifyAtFence(durablePath, durablePath, verified.sha256);
          const existing = EffectFunction.flow(
            Schema.decodeUnknownResult(Schema.UndefinedOr(Registration)),
            Result.getOrThrow,
          )(read.get(goalInstanceId));
          if (isTruthy(existing) && JSON.stringify(existing) !== JSON.stringify(verified))
            throw new Error("Conflicting native generation");
          if (!isTruthy(existing)) {
            if (isTruthy(historic.get(goalInstanceId, goalInstanceId)))
              throw new Error("Historical Goal has no native provenance; backfill refused");
            insert.run(
              goalInstanceId,
              verified.fileUrl,
              verified.sha256,
              verified.contractVersion,
              verified.sourceHash,
              DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe())),
            );
          }
        }),
      ),
    );
    const loaded = yield* loadTrustedNativeArtifact(verified, {
      explicitlyTrusted: true,
      ownerControlledDirectory: evaluation,
    });
    return loaded.factories;
  });
  return { acquire };
}
