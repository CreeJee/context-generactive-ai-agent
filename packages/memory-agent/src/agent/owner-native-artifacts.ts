// Native host/SDK boundary uses Node filesystem and SQLite contracts.
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { dirname, join } = platformPath;
import { pathToFileURL } from "node:url";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/sql";
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
  Effect.Success<ReturnType<typeof makeOwnerNativeArtifacts>>
>()("memory-agent/agent/owner-native-artifacts/OwnerNativeArtifacts") {
  static readonly layer = Layer.effect(
    OwnerNativeArtifacts,
    Effect.gen(function* () {
      const storage = yield* StorageRoot;
      const buildInput = yield* OwnerNativeBuild;
      const files = yield* OwnerNativeFiles;
      const prebuilt = yield* loadManifest(buildInput.manifest, files);
      return yield* makeOwnerNativeArtifacts({
        files,
        prebuilt,
        directory: join(storage.path, "native-artifacts"),
      });
    }),
  ).pipe(Layer.provide(OwnerNativeFiles.layer));
}

const registered = (cause: SqlError.SqlError | Schema.SchemaError) =>
  NativeRegistrationError.make({ cause });

/** Private owner boundary: only the build-produced descriptor may be registered.
 * Existing records are revalidated on every acquisition; runtime compilation and source fallback
 * do not exist on this path.
 */
export const makeOwnerNativeArtifacts = Effect.fnUntraced(function* (owner: {
  readonly directory: string;
  readonly files?: OwnerNativeFiles["Service"];
  readonly prebuilt?: PrebuiltArtifacts;
  readonly manifest?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const files = owner.files ?? OwnerNativeFiles.production;
  const read = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Registration,
    execute: (goalInstanceId) => sql`SELECT artifact_url AS fileUrl, artifact_hash AS sha256,
      contract_version AS contractVersion, source_hash AS sourceHash
      FROM workflow_goal_native_artifacts WHERE goal_instance_id = ${goalInstanceId}`,
  });
  const refuseHistoric = (goalInstanceId: string) =>
    sql`SELECT 1 FROM workflow_goal_worker_generations WHERE goal_instance_id = ${goalInstanceId}
      UNION ALL SELECT 1 FROM workflow_run_bindings WHERE goal_instance_id = ${goalInstanceId}
      LIMIT 1`.pipe(
      Effect.mapError(registered),
      Effect.filterOrFail(
        (rows) => rows.length === 0,
        () => NativeRegistrationError.make({ reason: "historical_goal" }),
      ),
    );
  const acquire = Effect.fn("OwnerNativeArtifacts.acquire")(function* (goalInstanceId: string) {
    const saved = yield* read(goalInstanceId).pipe(Effect.mapError(registered));
    const durable = yield* files.parent(owner.directory);
    // Evaluation is staged beside the packaged/checkout runtime so allowlisted bare imports resolve
    // to that runtime's node_modules, while the immutable source remains in durable owner storage.
    const evaluation = yield* files.parent(dirname(OwnerNativeBuild.production.manifest));
    if (Option.isSome(saved)) {
      const loaded = yield* loadTrustedNativeArtifact(saved.value, {
        explicitlyTrusted: true,
        ownerControlledDirectory: evaluation,
      });
      return loaded.factories;
    }
    yield* refuseHistoric(goalInstanceId);
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
    // The durable path is content-addressed owner storage, checked once right before it is recorded.
    yield* files.verify(durablePath, durablePath, verified.sha256);
    yield* Effect.uninterruptible(
      read(goalInstanceId).pipe(
        Effect.mapError(registered),
        Effect.flatMap(
          Option.match({
            onSome: (existing) =>
              existing.fileUrl === verified.fileUrl &&
              existing.sha256 === verified.sha256 &&
              existing.contractVersion === verified.contractVersion &&
              existing.sourceHash === verified.sourceHash
                ? Effect.void
                : Effect.fail(NativeRegistrationError.make({ reason: "conflicting_generation" })),
            onNone: () =>
              refuseHistoric(goalInstanceId).pipe(
                Effect.andThen(DateTime.now),
                Effect.flatMap((now) =>
                  sql`INSERT INTO workflow_goal_native_artifacts VALUES (${goalInstanceId},
                    ${verified.fileUrl}, ${verified.sha256}, ${verified.contractVersion},
                    ${verified.sourceHash}, ${DateTime.formatIso(now)})`.pipe(
                    Effect.mapError(registered),
                  ),
                ),
              ),
          }),
        ),
        sql.withTransaction,
        Effect.catchTag("SqlError", (cause) => Effect.fail(registered(cause))),
      ),
    );
    const loaded = yield* loadTrustedNativeArtifact(verified, {
      explicitlyTrusted: true,
      ownerControlledDirectory: evaluation,
    });
    return loaded.factories;
  });
  return { acquire };
});
