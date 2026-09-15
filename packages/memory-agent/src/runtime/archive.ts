import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { renameWhenReleased, tarExecutable } from "./host.ts";

const run = promisify(execFile);

/** A pinned `.tgz`: nothing is extracted unless the downloaded bytes have exactly this digest. */
export interface PinnedArchive {
  readonly url: string;
  readonly algorithm: "sha256" | "sha512";
  /** Lowercase hex. */
  readonly digest: string;
}

/** Why an archive did not install, with what went wrong for the app's log (never shown in the UI). */
export interface ArchiveFailure {
  readonly reason: "download_failed" | "checksum_mismatch" | "unsafe_archive" | "extract_failed";
  readonly detail: string;
}

/** An npm lockfile `integrity` value (`sha512-<base64>`) as a digest to check against. */
export function npmIntegrity(url: string, integrity: string): PinnedArchive {
  const [algorithm, base64 = ""] = integrity.split("-", 2);
  if (algorithm !== "sha512") throw new Error(`unsupported integrity algorithm: ${algorithm}`);
  return { url, algorithm, digest: Buffer.from(base64, "base64").toString("hex") };
}

/** An error's message with its cause: `fetch failed` alone hides DNS, proxy and certificate errors. */
const explain = (error: Error): string =>
  error.cause instanceof Error ? `${error.message}: ${explain(error.cause)}` : error.message;

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
  const failed = (reason: ArchiveFailure["reason"], detail: string) => ({ reason, detail });
  const response = await fetch(archive.url, { redirect: "follow" }).catch((error: Error) => error);
  if (response instanceof Error) return failed("download_failed", explain(response));
  if (!response.ok) return failed("download_failed", `HTTP ${response.status}`);
  const bytes = await response
    .arrayBuffer()
    .then((buffer) => Buffer.from(buffer))
    .catch((error: Error) => error);
  if (bytes instanceof Error) return failed("download_failed", explain(bytes));
  if (createHash(archive.algorithm).update(bytes).digest("hex") !== archive.digest)
    return failed("checksum_mismatch", `${archive.algorithm} differs from the pin`);

  const tar = tarExecutable();
  const staging = join(dirname(target), `.install-${randomUUID()}`);
  const extract = async (): Promise<ArchiveFailure | null> => {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const file = join(staging, "archive.tgz");
    writeFileSync(file, bytes, { mode: 0o600 });
    const { stdout } = await run(tar, ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 });
    const unsafe = stdout
      .trim()
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("/") || entry.split("/").includes(".."));
    if (unsafe !== undefined) return failed("unsafe_archive", unsafe);
    await run(tar, ["-xzf", file, "-C", staging]);
    rmSync(file, { maxRetries: 10, retryDelay: 200 });
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await renameWhenReleased(staging, target);
    return null;
  };
  const failure = await extract().catch((error: Error) => failed("extract_failed", explain(error)));
  if (failure !== null) rmSync(staging, { recursive: true, force: true });
  return failure;
}
