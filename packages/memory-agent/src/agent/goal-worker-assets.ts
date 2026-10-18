import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node filesystem contracts for immutable artifact publication.
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { basename, dirname, join, resolve } = platformPath;
import { Effect, FileSystem, MutableHashMap, Option, Schema, Semaphore } from "effect";
import { runtimeArtifact } from "../runtime/resources.ts";

const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const buildManifest = Schema.Struct({
  version: Schema.Literal(1),
  native: Schema.Struct({
    file: Schema.Literal("native.mjs"),
    sha256,
    sourceHash: sha256,
    contractVersion: Schema.Literal("native-factories/v1"),
  }),
  worker: Schema.Struct({ file: Schema.Literal("full-loop-worker.mjs"), sha256 }),
});
const snapshotManifest = Schema.Struct({
  goalInstanceId: Schema.String,
  sourceGeneration: sha256,
  canonicalWorkerUrl: Schema.String,
  workerHash: sha256,
});
const manifestName = "goal-assets-manifest.json";
const digest = (bytes: Uint8Array | string) => hashSha256(bytes);
// SQLite reserves a globally unique source pin. Identical build bytes still belong to distinct Goals.
const generationForGoal = (goalInstanceId: string, workerHash: string) =>
  digest(
    EffectFunction.flow(
      Schema.encodeResult(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))),
      Result.getOrThrow,
    )([goalInstanceId, workerHash]),
  );

export interface SavedGoalExecutionAssets {
  readonly goalInstanceId: string;
  readonly sourceGeneration: string;
  readonly manifestHash: string;
  readonly canonicalWorkerUrl: string;
}

export interface GoalExecutionAssets extends SavedGoalExecutionAssets {
  /** Goal/build pin, independent of Goal/Plan revisions and per-run capability generations. */
  readonly sourceGeneration: string;
  readonly workerUrl: URL;
}

/** Owner-local registry backed only by the build-produced worker manifest.
 * Each Goal receives a durable immutable pin of the same content-addressed worker bytes; no source
 * tree, SDK dependency tree or TypeScript entry is captured at first request.
 */
export class GoalWorkerAssetsFailed extends Schema.TaggedError<GoalWorkerAssetsFailed>()(
  "GoalWorkerAssetsFailed",
  { cause: Schema.Defect() },
) {}
const attempt = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => GoalWorkerAssetsFailed.make({ cause }) });
const failure = (cause: import("effect/PlatformError").PlatformError) =>
  GoalWorkerAssetsFailed.make({ cause });
const invalidPath = (cause: import("effect/PlatformError").BadArgument) =>
  GoalWorkerAssetsFailed.make({ cause });

export const makeGoalWorkerAssetsRegistry = Effect.fn("makeGoalWorkerAssetsRegistry")(function* (
  options: {
    readonly artifactManifest?: string;
    readonly temporaryDirectory?: string;
    readonly readFile?: (path: string) => Uint8Array;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const mutex = yield* Semaphore.make(1);
  const temporary = yield* fs
    .makeTempDirectory({ directory: options.temporaryDirectory, prefix: "goal-worker-assets-" })
    .pipe(Effect.mapError(failure));
  const root = yield* fs.realPath(temporary).pipe(Effect.mapError(failure));
  const goals = MutableHashMap.empty<string, GoalExecutionAssets>();
  let disposed = false;
  let activeLeases = 0;
  const customRead = options.readFile;
  const read =
    customRead === undefined
      ? (path: string) => fs.readFile(path).pipe(Effect.mapError(failure))
      : (path: string) => attempt(() => customRead(path));
  const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const active = (goalInstanceId: string) => {
    if (disposed || !(goalInstanceId.length > 0)) throw new Error("Inactive Goal asset registry");
  };

  const buildWorker = Effect.fn("GoalWorkerAssets.buildWorker")(function* () {
    const manifestPath = yield* fs
      .realPath(options.artifactManifest ?? runtimeArtifact("artifact-manifest.json"))
      .pipe(Effect.mapError(failure));
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(buildManifest))(
      decodeText(yield* read(manifestPath)),
    ).pipe(Effect.mapError((cause) => GoalWorkerAssetsFailed.make({ cause })));
    const path = yield* fs
      .realPath(join(dirname(manifestPath), manifest.worker.file))
      .pipe(Effect.mapError(failure));
    yield* attempt(() => {
      if (dirname(path) !== dirname(manifestPath))
        throw new Error("Goal worker escaped build root");
    });
    const bytes = yield* read(path);
    yield* attempt(() => {
      if (digest(bytes) !== manifest.worker.sha256) throw new Error("Goal worker SHA256 mismatch");
    });
    return { path, bytes, hash: manifest.worker.sha256 };
  });

  const snapshotLocation = Effect.fnUntraced(function* (saved: SavedGoalExecutionAssets) {
    const url = yield* attempt(() => {
      active(saved.goalInstanceId);
      if (!/^[a-f0-9]{64}$/.test(saved.sourceGeneration))
        throw new Error("Inactive Goal asset registry");
      const url = new URL(saved.canonicalWorkerUrl);
      if (url.protocol !== "file:" || url.href !== saved.canonicalWorkerUrl)
        throw new Error("Noncanonical Goal worker URL");
      return url;
    });
    const workerPath = yield* platformPath.fromFileUrl(url).pipe(Effect.mapError(invalidPath));
    const canonicalUrl = yield* platformPath
      .toFileUrl(workerPath)
      .pipe(Effect.mapError(invalidPath));
    const destination = dirname(workerPath);
    yield* attempt(() => {
      if (
        workerPath !== join(destination, "full-loop-worker.mjs") ||
        basename(dirname(destination)) !== saved.sourceGeneration ||
        canonicalUrl.href !== saved.canonicalWorkerUrl
      )
        throw new Error("Goal snapshot identity mismatch");
    });
    return { workerPath, destination };
  });
  const snapshotIdentity = (
    saved: SavedGoalExecutionAssets,
    workerPath: string,
    canonical: string,
    workerBytes: Uint8Array,
    bytes: Uint8Array,
  ): GoalExecutionAssets => {
    if (canonical !== workerPath) throw new Error("Goal snapshot identity mismatch");
    const workerHash = digest(workerBytes);
    if (
      workerHash !== saved.sourceGeneration &&
      generationForGoal(saved.goalInstanceId, workerHash) !== saved.sourceGeneration
    )
      throw new Error("Goal worker hash mismatch");
    if (digest(bytes) !== saved.manifestHash)
      throw new Error("Goal snapshot manifest hash mismatch");
    const manifest = EffectFunction.flow(
      Schema.decodeUnknownResult(Schema.fromJsonString(snapshotManifest)),
      Result.getOrThrow,
    )(decodeText(bytes));
    if (
      manifest.goalInstanceId !== saved.goalInstanceId ||
      manifest.sourceGeneration !== saved.sourceGeneration ||
      manifest.canonicalWorkerUrl !== saved.canonicalWorkerUrl ||
      manifest.workerHash !== workerHash
    )
      throw new Error("Goal snapshot identity mismatch");
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
  };
  const verify = Effect.fn("GoalWorkerAssets.verify")(function* (saved: SavedGoalExecutionAssets) {
    const { workerPath, destination } = yield* snapshotLocation(saved);
    const canonical = yield* fs.realPath(workerPath).pipe(Effect.mapError(failure));
    const workerBytes = yield* fs.readFile(workerPath).pipe(Effect.mapError(failure));
    const bytes = yield* fs
      .readFile(join(destination, manifestName))
      .pipe(Effect.mapError(failure));
    return yield* attempt(() => snapshotIdentity(saved, workerPath, canonical, workerBytes, bytes));
  });

  return {
    resolve: Effect.fn("GoalWorkerAssets.resolve")(
      function* (goalInstanceId: string) {
        yield* attempt(() => active(goalInstanceId));
        const existing = Option.getOrUndefined(MutableHashMap.get(goals, goalInstanceId));
        if (isTruthy(existing)) {
          yield* verify(existing);
          return existing;
        }
        const source = yield* buildWorker();
        const sourceGeneration = generationForGoal(goalInstanceId, source.hash);
        const destination = resolve(root, sourceGeneration, digest(goalInstanceId));
        yield* fs
          .makeDirectory(destination, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(failure));
        return yield* Effect.gen(function* () {
          const workerPath = join(destination, "full-loop-worker.mjs");
          yield* fs.copyFile(source.path, workerPath).pipe(Effect.mapError(failure));
          const copied = yield* fs.readFile(workerPath).pipe(Effect.mapError(failure));
          yield* attempt(() => {
            if (digest(copied) !== source.hash)
              throw new Error("Goal worker copy differs from build manifest");
          });
          const canonicalWorkerUrl = (yield* platformPath
            .toFileUrl(workerPath)
            .pipe(Effect.mapError(invalidPath))).href;
          const encodedManifest = yield* Schema.encodeEffect(
            Schema.fromJsonString(snapshotManifest),
          )({ goalInstanceId, sourceGeneration, canonicalWorkerUrl, workerHash: source.hash }).pipe(
            Effect.mapError((cause) => GoalWorkerAssetsFailed.make({ cause })),
          );
          const manifest = `${encodedManifest}\n`;
          yield* fs
            .writeFileString(join(destination, manifestName), manifest, { flag: "wx", mode: 0o400 })
            .pipe(Effect.mapError(failure));
          const assets = yield* verify({
            goalInstanceId,
            sourceGeneration,
            canonicalWorkerUrl,
            manifestHash: digest(manifest),
          });
          MutableHashMap.set(goals, goalInstanceId, assets);
          return assets;
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => MutableHashMap.remove(goals, goalInstanceId)).pipe(
              Effect.andThen(fs.remove(destination, { recursive: true, force: true })),
              Effect.orDie,
            ),
          ),
        );
      },
      (effect) => mutex.withPermit(effect),
    ),
    verify,
    /** Cold completed-Goal adoption only: validates saved bytes, never captures replacement code. */
    adopt: Effect.fn("GoalWorkerAssets.adopt")(
      function* (saved: SavedGoalExecutionAssets) {
        const verified = yield* verify(saved);
        const existing = Option.getOrUndefined(MutableHashMap.get(goals, saved.goalInstanceId));
        if (isTruthy(existing)) {
          yield* attempt(() => {
            if (
              existing.manifestHash !== verified.manifestHash ||
              existing.canonicalWorkerUrl !== verified.canonicalWorkerUrl ||
              existing.sourceGeneration !== verified.sourceGeneration
            )
              throw new Error("Goal asset pin conflict");
          });
          return existing;
        }
        MutableHashMap.set(goals, verified.goalInstanceId, verified);
        return verified;
      },
      (effect) => mutex.withPermit(effect),
    ),
    /**
     * Verifies the pinned bytes and takes a lease right before Worker construction; release only
     * after termination/exit (or boot failure). Holding the registry lock keeps disposal out.
     */
    use: Effect.fn("GoalWorkerAssets.use")(
      function* (assets: GoalExecutionAssets) {
        yield* attempt(() => {
          if (
            disposed ||
            Option.getOrUndefined(MutableHashMap.get(goals, assets.goalInstanceId)) !== assets
          )
            throw new Error("Unregistered Goal execution assets");
        });
        yield* verify(assets);
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
      (effect) => mutex.withPermit(effect),
    ),
    /** Refuses disposal until every owner-tracked Worker lease has been released. */
    dispose: Effect.fn("GoalWorkerAssets.dispose")(
      function* (options: { readonly remove?: boolean } = {}) {
        yield* attempt(() => {
          if (activeLeases !== 0) throw new Error("Goal asset workers are still active");
          disposed = true;
          MutableHashMap.clear(goals);
        });
        if (options.remove === true)
          yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.mapError(failure));
      },
      (effect, _options?: { readonly remove?: boolean }) => mutex.withPermit(effect),
    ),
  };
});
