import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { OwnerNativeBuild } from "./owner-native-build.ts";
import { OwnerNativeFiles } from "./owner-native-files.ts";
import { OwnerNativeBuilder, nativeDigest } from "./owner-native-builder.ts";
import { NativeRegistrationError } from "./owner-native-error.ts";
export { NativeRegistrationError } from "./owner-native-error.ts";

export class OwnerNativeArtifacts extends Context.Service<
  OwnerNativeArtifacts,
  ReturnType<typeof makeOwnerNativeArtifacts>
>()("memory-agent/agent/OwnerNativeArtifacts") {
  static readonly layer = Layer.effect(
    OwnerNativeArtifacts,
    Effect.gen(function* () {
      const database = yield* Database;
      const storage = yield* StorageRoot;
      const buildInput = yield* OwnerNativeBuild;
      const files = yield* OwnerNativeFiles;
      const builder = yield* OwnerNativeBuilder;
      return makeOwnerNativeArtifacts({
        ...database,
        files,
        builder,
        entry: buildInput.entry,
        directory: join(storage.path, "native-artifacts"),
      });
    }),
  ).pipe(Layer.provide(OwnerNativeBuilder.layer), Layer.provide(OwnerNativeFiles.layer));
}
import {
  loadTrustedNativeArtifact,
  nativeFactoryLoaderContract,
} from "./native-artifact-loader.ts";

const Registration = Schema.Struct({
  fileUrl: Schema.String,
  sha256: Schema.String,
  contractVersion: Schema.Literal(nativeFactoryLoaderContract),
  sourceHash: Schema.String,
});
/** Private owner boundary: no descriptor registration API and no manual artifact adoption.
 * Existing records are revalidated on every acquisition. Native dependencies remain host-owned;
 * this does not remove the owner build-ID gate or promise whole-process unloading.
 */
export function makeOwnerNativeArtifacts(owner: {
  readonly sqlite: DatabaseSync;
  readonly atomic: <T>(work: () => T) => T;
  readonly directory: string;
  readonly entry?: string;
  readonly files?: OwnerNativeFiles["Service"];
  readonly builder?: OwnerNativeBuilder["Service"];
}) {
  const files = owner.files ?? OwnerNativeFiles.production;
  const builder = owner.builder ?? OwnerNativeBuilder.make(files);
  const read = owner.sqlite.prepare(`SELECT artifact_url AS fileUrl, artifact_hash AS sha256,
    contract_version AS contractVersion, source_hash AS sourceHash
    FROM workflow_goal_native_artifacts WHERE goal_instance_id = ?`);
  const historic = owner.sqlite.prepare(`SELECT 1 FROM workflow_goal_worker_generations
    WHERE goal_instance_id = ? UNION ALL SELECT 1 FROM workflow_run_bindings WHERE goal_instance_id = ? LIMIT 1`);
  const insert = owner.sqlite.prepare(`INSERT INTO workflow_goal_native_artifacts
    VALUES (?, ?, ?, ?, ?, ?)`);
  const boundary = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (cause) => new NativeRegistrationError({ cause }),
    });
  const acquire = Effect.fn("OwnerNativeArtifacts.acquire")(function* (goalInstanceId: string) {
    const parent = yield* files.parent(owner.directory);
    const saved = yield* boundary(() =>
      Schema.decodeUnknownSync(Schema.UndefinedOr(Registration))(read.get(goalInstanceId)),
    );
    let registration = saved;
    if (!registration) {
      yield* boundary(() => {
        if (historic.get(goalInstanceId, goalInstanceId))
          throw new Error("Historical Goal has no native provenance; backfill refused");
      });
      const generated = yield* builder.build(owner.entry ?? OwnerNativeBuild.production.entry);
      const lease = yield* Effect.acquireRelease(
        files.temporary(join(parent, "generation-")),
        (directory) =>
          Effect.gen(function* () {
            // Even an atomic adapter that throws after committing must retain registered bytes.
            const saved = yield* boundary(() =>
              Schema.decodeUnknownSync(Schema.UndefinedOr(Registration))(read.get(goalInstanceId)),
            );
            if (saved?.fileUrl === pathToFileURL(join(directory, "native.mjs")).href) return;
            yield* files.remove(directory);
          }).pipe(Effect.orDie),
      );
      const path = join(lease, "native.mjs");
      yield* files.write(path, generated.code);
      registration = {
        fileUrl: pathToFileURL(path).href,
        sha256: nativeDigest(generated.code),
        contractVersion: nativeFactoryLoaderContract,
        sourceHash: generated.sourceHash,
      };
    }
    const real = yield* files.realpath(fileURLToPath(registration.fileUrl));
    yield* boundary(() => {
      if (!real.startsWith(parent + "/generation-"))
        throw new Error("Unknown native artifact origin");
    });
    const controlled = yield* files.realpath(fileURLToPath(new URL("./", import.meta.url)));
    const loaded = yield* loadTrustedNativeArtifact(registration, {
      explicitlyTrusted: true,
      ownerControlledDirectory: controlled,
    });
    const verified = registration;
    yield* Effect.uninterruptible(
      boundary(() =>
        owner.atomic(() => {
          files.verifyAtFence(fileURLToPath(verified.fileUrl), parent, verified.sha256);
          const existing = Schema.decodeUnknownSync(Schema.UndefinedOr(Registration))(
            read.get(goalInstanceId),
          );
          if (existing && JSON.stringify(existing) !== JSON.stringify(verified))
            throw new Error("Conflicting native generation");
          if (!existing) {
            // The async build may overlap an SDK-only generation or run admission.
            // Reuse registered provenance, but never backfill newly historical Goals.
            if (historic.get(goalInstanceId, goalInstanceId))
              throw new Error("Historical Goal has no native provenance; backfill refused");
            insert.run(
              goalInstanceId,
              verified.fileUrl,
              verified.sha256,
              verified.contractVersion,
              verified.sourceHash,
              new Date().toISOString(),
            );
          }
        }),
      ),
    );
    return loaded.factories;
  });
  return { acquire, registered: (goalInstanceId: string) => Boolean(read.get(goalInstanceId)) };
}
