import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAsset, getRawAsset, isSea } from "node:sea";
import { Schema } from "effect";

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
export function unpackRuntime(storageRoot: string): string | null {
  if (!isSea()) return null;
  const manifest = Schema.decodeUnknownSync(Schema.parseJson(RuntimeManifest))(
    getAsset(runtimeManifestAsset, "utf8"),
  );
  const runtimeFolder = join(storageRoot, "runtime");
  const root = join(runtimeFolder, manifest.hash);

  if (!existsSync(join(root, completeMarker))) {
    const staging = `${root}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    for (const file of manifest.files) {
      const target = join(staging, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, new Uint8Array(getRawAsset(`${runtimeFilePrefix}${file}`)));
    }
    writeFileSync(join(staging, completeMarker), "");
    rmSync(root, { recursive: true, force: true });
    try {
      renameSync(staging, root);
    } catch {
      // Another start of the same build finished first; its copy is identical.
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(join(root, completeMarker))) throw new Error("runtime unpack failed");
    }
  }

  // Remove unpacked folders from older builds.
  for (const entry of readdirSync(runtimeFolder))
    if (hashFolder.test(entry) && entry !== manifest.hash)
      rmSync(join(runtimeFolder, entry), { recursive: true, force: true });
  return root;
}
