import {
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Layer,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ArchiveHost,
  ArchiveInstaller,
  ArchiveInstallFailed,
  ArchiveInstallFailedReason,
  type PinnedArchive,
  type ArchiveStaging,
} from "./archive-install.ts";
import { tarExecutable } from "./host.ts";

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

const UnsupportedAlgorithm = Schema.TaggedStruct("UnsupportedAlgorithm", {
  algorithm: Schema.String,
});

export class ArchiveIntegrityRejected extends Schema.TaggedError<ArchiveIntegrityRejected>()(
  "ArchiveIntegrityRejected",
  { reason: UnsupportedAlgorithm },
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
      reason: UnsupportedAlgorithm.make({ algorithm: algorithm ?? "" }),
    });
  }
  return { url, algorithm, digest: Buffer.from(base64, "base64").toString("hex") };
}

const explain = (cause: unknown): string =>
  cause instanceof Error
    ? `${cause.message}${cause.cause instanceof Error ? `: ${explain(cause.cause)}` : ""}`
    : String(cause);

const HostOperationFailed = ArchiveInstallFailedReason.cases.HostOperationFailed;

const hostFailure = (operation: typeof HostOperationFailed.Type.operation) => (cause: unknown) =>
  ArchiveInstallFailed.make({ reason: HostOperationFailed.make({ operation, cause }) });

interface ArchiveCommandOutput {
  readonly chunks: Uint8Array[];
  readonly size: number;
}

/** Each command scope drains output and settles the process before releasing staging. */
const archiveCommand = Effect.fn("ArchiveHost.command")(function* (
  options: {
    readonly operation: "list" | "extract";
    readonly args: ReadonlyArray<string>;
    readonly maxBuffer: number;
  },
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const collect = (output: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
    output.pipe(
      Stream.runFoldEffect(
        (): ArchiveCommandOutput => ({ chunks: [], size: 0 }),
        (state, chunk) => {
          const size = state.size + chunk.byteLength;
          if (size > options.maxBuffer)
            return Effect.fail(hostFailure(options.operation)("tar output exceeds buffer limit"));
          state.chunks.push(chunk);
          return Effect.succeed({ chunks: state.chunks, size });
        },
      ),
      Effect.map(({ chunks, size }) => new TextDecoder().decode(Buffer.concat(chunks, size))),
    );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(tarExecutable(), [...options.args], { stdin: "ignore" }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      yield* Effect.when(
        Effect.fail(hostFailure(options.operation)(`tar exited with code ${exitCode}`)),
        Effect.succeed(exitCode !== 0),
      );
      return stdout;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ArchiveInstallFailed)(cause) ? cause : hostFailure(options.operation)(cause),
      ),
    ),
  );
});

const removalCode = Schema.is(
  Schema.Struct({
    code: Schema.Literals(["EBUSY", "ENOTEMPTY", "EPERM", "EMFILE", "ENFILE"]),
  }),
);
const renameCode = Schema.is(
  Schema.Struct({ code: Schema.Literals(["EPERM", "EACCES", "EBUSY"]) }),
);
const removalRetries = Schedule.recurs(10).pipe(
  Schedule.addDelay(({ output }) => Effect.succeed(Duration.millis(200 * (output + 1)))),
);

/** Platform services are captured at construction; methods expose only the archive contract. */
export const archiveHostLayer = Layer.effect(
  ArchiveHost,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Node filesystem calls cannot abort; settle each call before staging is released.
    const remove = (file: string) =>
      fs.remove(file, { recursive: true, force: true }).pipe(
        Effect.uninterruptible,
        Effect.retry({
          schedule: removalRetries,
          while: (error) => removalCode(error.reason.cause),
        }),
      );
    return ArchiveHost.of({
      download: Effect.fn("ArchiveHost.download")(function* (url: string) {
        const response = yield* client.get(url).pipe(
          Effect.mapError((cause) =>
            ArchiveInstallFailed.make({
              reason: ArchiveInstallFailedReason.cases.DownloadFailed.make({ cause }),
            }),
          ),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* ArchiveInstallFailed.make({
            reason: ArchiveInstallFailedReason.cases.HttpStatus.make({ status: response.status }),
          });
        return yield* response.arrayBuffer.pipe(
          Effect.map((bytes) => new Uint8Array(bytes)),
          Effect.mapError((cause) =>
            ArchiveInstallFailed.make({
              reason: ArchiveInstallFailedReason.cases.DownloadFailed.make({ cause }),
            }),
          ),
        );
      }),
      checksum: (options) =>
        crypto.digest(options.algorithm === "sha256" ? "SHA-256" : "SHA-512", options.bytes).pipe(
          Effect.map((digest) => Buffer.from(digest).toString("hex")),
          Effect.mapError(hostFailure("checksum")),
        ),
      stage: Effect.fn("ArchiveHost.stage")(
        function* (target: string) {
          const parent = path.dirname(target);
          yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
          const directory = yield* fs.makeTempDirectory({ directory: parent, prefix: ".install-" });
          return { directory, file: path.join(directory, "archive.tgz") };
        },
        Effect.mapError(hostFailure("stage")),
      ),
      write: (options) =>
        fs
          .writeFile(options.staging.file, options.bytes, { mode: 0o600 })
          .pipe(Effect.uninterruptible, Effect.mapError(hostFailure("write"))),
      list: (staging) =>
        archiveCommand(
          {
            operation: "list",
            args: ["-tzf", staging.file],
            maxBuffer: 64 * 1024 * 1024,
          },
          spawner,
        ),
      extract: (staging) =>
        archiveCommand(
          {
            operation: "extract",
            args: ["-xzf", staging.file, "-C", staging.directory],
            maxBuffer: 1024 * 1024,
          },
          spawner,
        ).pipe(Effect.asVoid),
      publish: Effect.fn("ArchiveHost.publish")(
        function* (options: { readonly staging: ArchiveStaging; readonly target: string }) {
          yield* remove(options.staging.file);
          yield* remove(options.target);
          yield* fs.rename(options.staging.directory, options.target).pipe(
            Effect.uninterruptible,
            Effect.retry({
              times: 19,
              schedule: Schedule.spaced("500 millis"),
              while: (error) => process.platform === "win32" && renameCode(error.reason.cause),
            }),
          );
        },
        Effect.mapError(hostFailure("publish")),
      ),
      cleanup: (staging) => remove(staging.directory).pipe(Effect.mapError(hostFailure("cleanup"))),
    });
  }),
).pipe(
  Layer.provide(
    Layer.merge(
      FetchHttpClient.layer,
      // The spawner's own file system and path; the host's come from whoever provides this layer.
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  ),
);

/** The installer on the Node host, for Effect consumers. */
export const archiveInstallerLayer = ArchiveInstaller.layer.pipe(
  Layer.provide(archiveHostLayer),
  Layer.provide(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
);

const nativeFailure = (error: ArchiveInstallFailed) =>
  ArchiveInstallFailedReason.match<ArchiveFailure>(error.reason, {
    DownloadFailed: ({ cause }) => ({ reason: "download_failed", detail: explain(cause) }),
    HttpStatus: ({ status }) => ({ reason: "download_failed", detail: `HTTP ${status}` }),
    ChecksumMismatch: ({ algorithm }) => ({
      reason: "checksum_mismatch",
      detail: `${algorithm} differs from the pin`,
    }),
    UnsafeEntry: ({ entry }) => ({ reason: "unsafe_archive", detail: entry }),
    HostOperationFailed: ({ cause }) => ({ reason: "extract_failed", detail: explain(cause) }),
  });

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
        const context = yield* Layer.build(archiveInstallerLayer);
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
