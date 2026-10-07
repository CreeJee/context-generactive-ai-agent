import { Effect, Function as EffectFunction, Layer, Schema } from "effect";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ArchiveHost,
  ArchiveInstaller,
  ArchiveInstallFailed,
  type PinnedArchive,
  type ArchiveStaging,
} from "./archive-install.ts";
import { renameWhenReleasedEffect, tarExecutable } from "./host.ts";

export {
  ArchiveHost,
  ArchiveInstaller,
  ArchiveInstallFailed,
  type PinnedArchive,
} from "./archive-install.ts";

/** Public result for the native caller; domain code uses ArchiveInstallFailed. */
export interface ArchiveFailure {
  readonly reason: "download_failed" | "checksum_mismatch" | "unsafe_archive" | "extract_failed";
  readonly detail: string;
}

export class ArchiveIntegrityRejected extends Schema.TaggedError<ArchiveIntegrityRejected>()(
  "ArchiveIntegrityRejected",
  { reason: Schema.TaggedStruct("UnsupportedAlgorithm", { algorithm: Schema.String }) },
) {
  override get message() {
    return `unsupported integrity algorithm: ${this.reason.algorithm}`;
  }
}

export const npmIntegrity: {
  (integrity: string): (url: string) => ReturnType<typeof npmIntegrityBody>;
} & typeof npmIntegrityBody = EffectFunction.dual(2, npmIntegrityBody);
function npmIntegrityBody(url: string, integrity: string): PinnedArchive {
  const [algorithm, base64 = ""] = integrity.split("-", 2);
  if (algorithm !== "sha512") {
    throw ArchiveIntegrityRejected.make({
      reason: { _tag: "UnsupportedAlgorithm", algorithm: algorithm ?? "" },
    });
  }
  return { url, algorithm, digest: Buffer.from(base64, "base64").toString("hex") };
}

const explain = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  return cause.cause instanceof Error ? `${cause.message}: ${explain(cause.cause)}` : cause.message;
};

const hostFailure =
  (
    operation: Extract<
      ArchiveInstallFailed["reason"],
      { _tag: "HostOperationFailed" }
    >["operation"],
  ) =>
  (cause: unknown) =>
    ArchiveInstallFailed.make({ reason: { _tag: "HostOperationFailed", operation, cause } });

/** Wait for close before releasing staging, including when interruption kills tar. */
const archiveCommand = (options: {
  readonly operation: "list" | "extract";
  readonly args: ReadonlyArray<string>;
  readonly maxBuffer: number;
}) =>
  Effect.callback<string, ArchiveInstallFailed>((resume) => {
    let closed = false;
    let outcome: Effect.Effect<string, ArchiveInstallFailed> | undefined;
    const child = execFile(
      tarExecutable(),
      [...options.args],
      { maxBuffer: options.maxBuffer },
      (error, stdout) => {
        outcome =
          error === null
            ? Effect.succeed(stdout)
            : Effect.fail(hostFailure(options.operation)(error));
      },
    );
    child.once("close", () => {
      closed = true;
      resume(
        outcome ??
          Effect.fail(hostFailure(options.operation)("tar closed without a completion callback")),
      );
    });
    return Effect.callback<void>((complete) => {
      if (closed) {
        complete(Effect.void);
        return;
      }
      child.once("close", () => complete(Effect.void));
      child.kill();
    });
  });

/** Node ABI adapter: individual I/O operations, not the installation workflow. */
export const archiveHostLayer = Layer.succeed(
  ArchiveHost,
  ArchiveHost.of({
    download: Effect.fn("ArchiveHost.download")(function* (url: string) {
      // One fiber signal owns both the request and consumption of its response body.
      return yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, { redirect: "follow", signal }).then((response) => {
            if (!response.ok) {
              throw ArchiveInstallFailed.make({
                reason: { _tag: "HttpStatus", status: response.status },
              });
            }
            return response.arrayBuffer().then((bytes) => new Uint8Array(bytes));
          }),
        catch: (cause) =>
          Schema.is(ArchiveInstallFailed)(cause)
            ? cause
            : ArchiveInstallFailed.make({ reason: { _tag: "DownloadFailed", cause } }),
      });
    }),
    checksum: (options) =>
      Effect.try({
        try: () => createHash(options.algorithm).update(options.bytes).digest("hex"),
        catch: hostFailure("checksum"),
      }),
    stage: (target) =>
      Effect.try({
        try: () => {
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          const directory = mkdtempSync(join(dirname(target), ".install-"));
          return { directory, file: join(directory, "archive.tgz") };
        },
        catch: hostFailure("stage"),
      }),
    write: (options) =>
      Effect.try({
        try: () => writeFileSync(options.staging.file, options.bytes, { mode: 0o600 }),
        catch: hostFailure("write"),
      }),
    list: (staging) =>
      archiveCommand({
        operation: "list",
        args: ["-tzf", staging.file],
        maxBuffer: 64 * 1024 * 1024,
      }),
    extract: (staging) =>
      archiveCommand({
        operation: "extract",
        args: ["-xzf", staging.file, "-C", staging.directory],
        maxBuffer: 1024 * 1024,
      }).pipe(Effect.asVoid),
    publish: Effect.fn("ArchiveHost.publish")(function* (options: {
      readonly staging: ArchiveStaging;
      readonly target: string;
    }) {
      yield* Effect.try({
        try: () => {
          rmSync(options.staging.file, { maxRetries: 10, retryDelay: 200 });
          rmSync(options.target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        },
        catch: hostFailure("publish"),
      });
      yield* renameWhenReleasedEffect({ from: options.staging.directory, to: options.target }).pipe(
        Effect.mapError(hostFailure("publish")),
      );
    }),
    cleanup: (staging) =>
      Effect.try({
        try: () =>
          rmSync(staging.directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          }),
        catch: hostFailure("cleanup"),
      }),
  }),
);

const installerLayer = ArchiveInstaller.layer.pipe(Layer.provide(archiveHostLayer));

const nativeFailure = (error: ArchiveInstallFailed): ArchiveFailure => {
  switch (error.reason._tag) {
    case "DownloadFailed":
      return { reason: "download_failed", detail: explain(error.reason.cause) };
    case "HttpStatus":
      return { reason: "download_failed", detail: `HTTP ${error.reason.status}` };
    case "ChecksumMismatch":
      return {
        reason: "checksum_mismatch",
        detail: `${error.reason.algorithm} differs from the pin`,
      };
    case "UnsafeEntry":
      return { reason: "unsafe_archive", detail: error.reason.entry };
    case "HostOperationFailed":
      return { reason: "extract_failed", detail: explain(error.reason.cause) };
  }
};

/** Native Promise entry point. Effect consumers compose ArchiveInstaller in their own runtime. */
export const installArchive: {
  (target: string): (archive: PinnedArchive) => ReturnType<typeof installArchiveBody>;
} & typeof installArchiveBody = EffectFunction.dual(2, installArchiveBody);
function installArchiveBody(
  archive: PinnedArchive,
  target: string,
): Promise<ArchiveFailure | null> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(installerLayer);
        return yield* Effect.flatMap(ArchiveInstaller, (installer) =>
          installer.install({ archive, target }),
        ).pipe(
          Effect.provideContext(context),
          Effect.as(null),
          Effect.catchTag("ArchiveInstallFailed", (error) => Effect.succeed(nativeFailure(error))),
        );
      }),
    ),
  );
}
