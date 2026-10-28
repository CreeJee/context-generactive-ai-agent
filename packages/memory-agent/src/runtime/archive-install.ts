import { Array as EffectArray, Context, Effect, Layer, Option, Schema } from "effect";

export interface PinnedArchive {
  readonly url: string;
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
}

export const ArchiveInstallFailedReason = Schema.TaggedUnion({
  DownloadFailed: { cause: Schema.Defect() },
  HttpStatus: { status: Schema.Int },
  ChecksumMismatch: { algorithm: Schema.Literals(["sha256", "sha512"]) },
  UnsafeEntry: { entry: Schema.String },
  HostOperationFailed: {
    operation: Schema.Literals([
      "checksum",
      "stage",
      "write",
      "list",
      "extract",
      "publish",
      "cleanup",
    ]),
    cause: Schema.Defect(),
  },
});

export class ArchiveInstallFailed extends Schema.TaggedError<
  ArchiveInstallFailed,
  { readonly brand: unique symbol }
>()("ArchiveInstallFailed", { reason: ArchiveInstallFailedReason }) {}

export interface ArchiveStaging {
  readonly directory: string;
  readonly file: string;
}

/** Host I/O is injectable; installation policy owns its order and lifetime. */
export class ArchiveHost extends Context.Service<
  ArchiveHost,
  {
    readonly download: (url: string) => Effect.Effect<Uint8Array, ArchiveInstallFailed>;
    readonly checksum: (options: {
      readonly bytes: Uint8Array;
      readonly algorithm: PinnedArchive["algorithm"];
    }) => Effect.Effect<string, ArchiveInstallFailed>;
    readonly stage: (target: string) => Effect.Effect<ArchiveStaging, ArchiveInstallFailed>;
    readonly write: (options: {
      readonly staging: ArchiveStaging;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<void, ArchiveInstallFailed>;
    readonly list: (staging: ArchiveStaging) => Effect.Effect<string, ArchiveInstallFailed>;
    readonly extract: (staging: ArchiveStaging) => Effect.Effect<void, ArchiveInstallFailed>;
    readonly publish: (options: {
      readonly staging: ArchiveStaging;
      readonly target: string;
    }) => Effect.Effect<void, ArchiveInstallFailed>;
    readonly cleanup: (staging: ArchiveStaging) => Effect.Effect<void, ArchiveInstallFailed>;
  }
>()("memory-agent/runtime/archive-install/ArchiveHost") {}

export class ArchiveInstaller extends Context.Service<
  ArchiveInstaller,
  {
    readonly install: (options: {
      readonly archive: PinnedArchive;
      readonly target: string;
    }) => Effect.Effect<void, ArchiveInstallFailed>;
  }
>()("memory-agent/runtime/archive-install/ArchiveInstaller") {
  static readonly layer = Layer.effect(
    ArchiveInstaller,
    Effect.gen(function* () {
      const host = yield* ArchiveHost;
      const install = Effect.fn("ArchiveInstaller.install")(function* (options: {
        readonly archive: PinnedArchive;
        readonly target: string;
      }) {
        const { archive, target } = options;
        const bytes = yield* host.download(archive.url);
        const digest = yield* host.checksum({ bytes, algorithm: archive.algorithm });
        yield* Effect.when(
          Effect.fail(
            ArchiveInstallFailed.make({
              reason: ArchiveInstallFailedReason.cases.ChecksumMismatch.make({
                algorithm: archive.algorithm,
              }),
            }),
          ),
          Effect.succeed(digest !== archive.digest),
        );
        yield* Effect.acquireUseRelease(
          host.stage(target),
          (staging) =>
            Effect.gen(function* () {
              yield* host.write({ staging, bytes });
              const listing = yield* host.list(staging);
              const unsafe = EffectArray.findFirst(
                listing.trim().split(/\r?\n/),
                (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
              );
              yield* Option.match(unsafe, {
                onNone: () => Effect.void,
                onSome: (entry) =>
                  Effect.fail(
                    ArchiveInstallFailed.make({
                      reason: ArchiveInstallFailedReason.cases.UnsafeEntry.make({ entry }),
                    }),
                  ),
              });
              yield* host.extract(staging);
              yield* host.publish({ staging, target });
            }),
          host.cleanup,
        );
      });
      return ArchiveInstaller.of({ install });
    }),
  );
}
