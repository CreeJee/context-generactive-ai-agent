import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A pinned `.tgz`: nothing is extracted unless the downloaded bytes have exactly this digest. */
export interface PinnedArchive {
  readonly url: string;
  readonly algorithm: "sha256" | "sha512";
  /** Lowercase hex. */
  readonly digest: string;
}

/** Why an archive did not install. */
export type ArchiveFailure =
  | "download_failed"
  | "checksum_mismatch"
  | "unsafe_archive"
  | "extract_failed";

/** An npm lockfile `integrity` value (`sha512-<base64>`) as a digest to check against. */
export function npmIntegrity(url: string, integrity: string): PinnedArchive {
  const [algorithm, base64 = ""] = integrity.split("-", 2);
  if (algorithm !== "sha512") throw new Error(`unsupported integrity algorithm: ${algorithm}`);
  return { url, algorithm, digest: Buffer.from(base64, "base64").toString("hex") };
}

/**
 * Downloads, checks and extracts an archive into `target`; resolves with why it did not, or null.
 * It is extracted beside `target` and renamed into place, so a crash or a bad archive never leaves
 * a half-installed folder in use; an existing `target` is replaced only after the new one is
 * complete. Never rejects.
 */
export async function installArchive(
  archive: PinnedArchive,
  target: string,
): Promise<ArchiveFailure | null> {
  const response = await fetch(archive.url, { redirect: "follow" }).catch(() => null);
  if (!response?.ok) return "download_failed";
  const bytes = await response
    .arrayBuffer()
    .then((buffer) => Buffer.from(buffer))
    .catch(() => null);
  if (!bytes) return "download_failed";
  if (createHash(archive.algorithm).update(bytes).digest("hex") !== archive.digest)
    return "checksum_mismatch";

  const staging = join(dirname(target), `.install-${randomUUID()}`);
  const extract = async (): Promise<ArchiveFailure | null> => {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const file = join(staging, "archive.tgz");
    writeFileSync(file, bytes, { mode: 0o600 });
    const { stdout } = await run("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 });
    const entries = stdout.trim().split("\n");
    if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes("..")))
      return "unsafe_archive";
    await run("tar", ["-xzf", file, "-C", staging]);
    rmSync(file);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return null;
  };
  const failure = await extract().catch((): ArchiveFailure => "extract_failed");
  if (failure !== null) rmSync(staging, { recursive: true, force: true });
  return failure;
}
