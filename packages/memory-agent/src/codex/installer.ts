import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { installArchive, npmIntegrity, type ArchiveFailure } from "../runtime/archive.ts";

/** Written by the packaging script next to the unpacked runtime: the pinned codex for this platform. */
export const codexManifestFile = "codex.json";

export const CodexManifest = Schema.Struct({
  /** `@openai/codex` version, e.g. "0.154.0". */
  version: Schema.String,
  /** Rust target triple of the platform package, e.g. "aarch64-apple-darwin". */
  triple: Schema.String,
  /** npm registry tarball of the platform package. */
  url: Schema.String,
  /** The lockfile's `integrity` for that tarball (`sha512-…`). */
  integrity: Schema.String,
});
export type CodexManifest = typeof CodexManifest.Type;

export type CodexInstallState =
  | { readonly kind: "ready"; readonly executable: string }
  | { readonly kind: "installing" }
  | { readonly kind: "failed"; readonly reason: ArchiveFailure };

/**
 * After a failure, the next check starts over only this long later: every attempt downloads the
 * whole platform package again (142 MB on Windows), so status polling must not repeat it quickly.
 */
const retryAfterMs = 60_000;

/**
 * The codex the executable runs: the pinned npm platform package, downloaded on first need into
 * `<storage>/runtime/codex-<version>-<platform>-<arch>`. A codex the user installed is never used,
 * even at the same version, because this app depends on codex's experimental app-server API.
 */
export function codexInstaller(storageRoot: string, runtime: string) {
  const manifest = Schema.decodeUnknownSync(Schema.parseJson(CodexManifest))(
    readFileSync(join(runtime, codexManifestFile), "utf8"),
  );
  const target = join(
    storageRoot,
    "runtime",
    `codex-${manifest.version}-${process.platform}-${process.arch}`,
  );
  const executable = join(
    target,
    "package",
    "vendor",
    manifest.triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  let installing: Promise<void> | null = null;
  let failure: { reason: ArchiveFailure; at: number } | null = null;

  const start = () => {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    installing = installArchive(npmIntegrity(manifest.url, manifest.integrity), target).then(
      (reason) => {
        installing = null;
        failure = reason === null ? null : { reason, at: Date.now() };
        // The UI only says the install failed; the terminal running the app keeps why.
        if (reason !== null)
          console.error(`codex install failed (${reason.reason}): ${reason.detail}`);
      },
    );
  };

  return {
    manifest,
    /** Where codex is, or starts installing it and says so. Never waits for the download. */
    check(): CodexInstallState {
      if (existsSync(executable)) return { kind: "ready", executable };
      if (installing) return { kind: "installing" };
      if (failure && Date.now() - failure.at < retryAfterMs)
        return { kind: "failed", reason: failure.reason };
      start();
      return { kind: "installing" };
    },
    /** Resolves when the current install attempt ends, however it ends. For tests and startup. */
    settled: () => installing ?? Promise.resolve(),
  };
}
