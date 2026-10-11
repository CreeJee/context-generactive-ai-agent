import { Cause, Effect, FileSystem, ManagedRuntime, Option, Path, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { getAsset, getRawAsset, isSea } from "node:sea";

/** Asset names inside the executable: the manifest, and one asset per runtime file under this prefix. */
export const runtimeManifestAsset = "runtime/manifest.json";
export const runtimeFilePrefix = "runtime/files/";

export const RuntimeManifest = Schema.Struct({
  /** First 16 hex characters of the sha256 over every file name and content. */
  hash: Schema.String,
  /** Paths relative to the runtime folder. */
  files: Schema.Array(Schema.String),
});

const hashFolder = /^[0-9a-f]{16}$/;
const completeMarker = ".complete";

/**
 * Unpacks the files the executable carries (client build, native packages and Kiwi worker) into
 * `<storage>/runtime/<hash>`, once per build, and removes folders of other builds.
 * Returns that folder, or null when not running as the executable.
 */
const runtimeAssets = ManagedRuntime.make(NodeServices.layer);
const unpack = Effect.fn("runtime.unpack")(function* (storageRoot: string) {
  if (!isSea()) return null;
  const fs = yield* FileSystem.FileSystem;
  const { dirname, join } = yield* Path.Path;
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(RuntimeManifest))(
    getAsset(runtimeManifestAsset, "utf8"),
  );
  const runtimeFolder = join(storageRoot, "runtime");
  const root = join(runtimeFolder, manifest.hash);
  if (!(yield* fs.exists(join(root, completeMarker)))) {
    const stagingPath = `${root}.staging-${process.pid}`;
    const staging = yield* Effect.acquireRelease(
      fs
        .remove(stagingPath, { recursive: true, force: true })
        .pipe(
          Effect.andThen(fs.makeDirectory(stagingPath, { recursive: true, mode: 0o700 })),
          Effect.as(stagingPath),
        ),
      (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    for (const file of manifest.files) {
      const target = join(staging, file);
      yield* fs.makeDirectory(dirname(target), { recursive: true, mode: 0o700 });
      yield* fs.writeFile(target, new Uint8Array(getRawAsset(`${runtimeFilePrefix}${file}`)));
    }
    yield* fs.writeFileString(join(staging, completeMarker), "");
    yield* fs.remove(root, { recursive: true, force: true });
    const promoted = yield* fs.rename(staging, root).pipe(Effect.option);
    if (Option.isNone(promoted)) {
      yield* fs.remove(staging, { recursive: true, force: true });
      if (!(yield* fs.exists(join(root, completeMarker))))
        return yield* new Cause.UnknownError(new Error("runtime unpack failed"));
    }
  }
  for (const entry of yield* fs.readDirectory(runtimeFolder))
    if (hashFolder.test(entry) && entry !== manifest.hash)
      yield* fs.remove(join(runtimeFolder, entry), { recursive: true, force: true });
  return root;
});

export const unpackRuntime = (storageRoot: string) =>
  runtimeAssets.runPromise(Effect.scoped(unpack(storageRoot)));
