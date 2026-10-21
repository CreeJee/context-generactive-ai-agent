import { expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
} from "effect";
import {
  ArchiveHost,
  ArchiveInstaller,
  ArchiveInstallFailed,
  ArchiveInstallFailedReason,
  type PinnedArchive,
} from "../src/runtime/archive-install.ts";
import {
  archiveHostLayer,
  ArchiveIntegrityRejected,
  npmIntegrity,
} from "../src/runtime/archive.ts";
import { TestClock } from "effect/testing";
import { tgz } from "./support/tgz.ts";

const pin: PinnedArchive = {
  url: "https://example.test/tool.tgz",
  algorithm: "sha256",
  digest: "matching",
};
const staging = { directory: "staging", file: "staging/archive.tgz" };
const fixture = () => {
  const calls: string[] = [];
  const record = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
    });
  const host = ArchiveHost.of({
    download: () => record("download").pipe(Effect.as(new Uint8Array())),
    checksum: () => record("checksum").pipe(Effect.as("matching")),
    stage: () => record("stage").pipe(Effect.as(staging)),
    write: () => record("write"),
    list: () => record("list").pipe(Effect.as("package/tool\n")),
    extract: () => record("extract"),
    publish: () => record("publish"),
    cleanup: () => record("cleanup"),
  });
  return { calls, host };
};

const install = Effect.fnUntraced(function* (host: ArchiveHost["Service"]) {
  const context = yield* Layer.build(
    ArchiveInstaller.layer.pipe(Layer.provide(Layer.succeed(ArchiveHost, host))),
  );
  yield* Context.get(context, ArchiveInstaller).install({ archive: pin, target: "target" });
});

it.effect("validates and extracts before publishing, then releases staging", () =>
  Effect.gen(function* () {
    const { host, calls } = fixture();
    yield* install(host);
    expect(calls).toEqual([
      "download",
      "checksum",
      "stage",
      "write",
      "list",
      "extract",
      "publish",
      "cleanup",
    ]);
  }),
);

it.effect("checksum mismatch never stages; escaping entries never extract or publish", () =>
  Effect.gen(function* () {
    const mismatch = fixture();
    expect(
      (yield* Effect.flip(install({ ...mismatch.host, checksum: () => Effect.succeed("wrong") })))
        .reason,
    ).toEqual(ArchiveInstallFailedReason.cases.ChecksumMismatch.make({ algorithm: "sha256" }));
    expect(mismatch.calls).toEqual(["download"]);
    const unsafe = fixture();
    expect(
      (yield* Effect.flip(install({ ...unsafe.host, list: () => Effect.succeed("../outside\n") })))
        .reason,
    ).toEqual(ArchiveInstallFailedReason.cases.UnsafeEntry.make({ entry: "../outside" }));
    expect(unsafe.calls).toEqual(["download", "checksum", "stage", "write", "cleanup"]);
  }),
);

it.effect("extract and cleanup failures remain typed; interruption waits for cleanup", () =>
  Effect.gen(function* () {
    const failed = fixture();
    const error = ArchiveInstallFailed.make({
      reason: ArchiveInstallFailedReason.cases.HostOperationFailed.make({
        operation: "extract",
        cause: "tar failed",
      }),
    });
    expect(yield* Effect.flip(install({ ...failed.host, extract: () => Effect.fail(error) }))).toBe(
      error,
    );
    expect(failed.calls.at(-1)).toBe("cleanup");
    expect(failed.calls).not.toContain("publish");
    const cleanupError = ArchiveInstallFailed.make({
      reason: ArchiveInstallFailedReason.cases.HostOperationFailed.make({
        operation: "cleanup",
        cause: "busy",
      }),
    });
    expect(
      yield* Effect.flip(install({ ...fixture().host, cleanup: () => Effect.fail(cleanupError) })),
    ).toBe(cleanupError);
    const cancelled = fixture();
    const entered = yield* Deferred.make<void>();
    const extracting = yield* Effect.forkChild(
      install({
        ...cancelled.host,
        extract: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(extracting);
    assertTrue(Exit.hasInterrupts(yield* Fiber.await(extracting)));
    expect(cancelled.calls.at(-1)).toBe("cleanup");
    expect(cancelled.calls).not.toContain("publish");
  }),
);

it.live("native adapter installs real tar contents and keeps an existing target on rejection", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      archiveHostLayer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    const fs = Context.get(context, FileSystem.FileSystem);
    const path = Context.get(context, Path.Path);
    const native = Context.get(context, ArchiveHost);
    const directory = yield* fs.makeTempDirectoryScoped();
    const target = path.join(directory, "tool");
    yield* fs.makeDirectory(target);
    yield* fs.writeFileString(path.join(target, "old"), "old");
    const bytes = tgz([{ name: "package/tool", content: "installed" }]);
    const digest = yield* native.checksum({ bytes, algorithm: "sha256" });
    const installerContext = yield* Layer.build(
      ArchiveInstaller.layer.pipe(
        Layer.provide(
          Layer.succeed(ArchiveHost, {
            ...native,
            download: () => Effect.succeed(bytes),
          }),
        ),
      ),
    );
    const installer = Context.get(installerContext, ArchiveInstaller);
    expect(
      (yield* Effect.flip(installer.install({ archive: { ...pin, digest: "wrong" }, target })))
        .reason,
    ).toEqual(ArchiveInstallFailedReason.cases.ChecksumMismatch.make({ algorithm: "sha256" }));
    expect(yield* fs.readFileString(path.join(target, "old"))).toBe("old");
    yield* installer.install({ archive: { ...pin, digest }, target });
    expect(yield* fs.readFileString(path.join(target, "package/tool"))).toBe("installed");
    expect(yield* fs.readDirectory(directory)).toEqual(["tool"]);
    for (const rejected of [
      {
        bytes: tgz([{ name: "../outside", content: "escape" }]),
        isReason: ArchiveInstallFailedReason.guards.UnsafeEntry,
      },
      {
        bytes: new Uint8Array([1, 2, 3]),
        isReason: ArchiveInstallFailedReason.guards.HostOperationFailed,
      },
    ]) {
      const rejectedDigest = yield* native.checksum({ bytes: rejected.bytes, algorithm: "sha256" });
      const rejectedContext = yield* Layer.build(
        ArchiveInstaller.layer.pipe(
          Layer.provide(
            Layer.succeed(ArchiveHost, {
              ...native,
              download: () => Effect.succeed(rejected.bytes),
            }),
          ),
        ),
      );
      const failure = yield* Effect.flip(
        Context.get(rejectedContext, ArchiveInstaller).install({
          archive: { ...pin, digest: rejectedDigest },
          target,
        }),
      );
      expect(rejected.isReason(failure.reason)).toBe(true);
      expect(yield* fs.readFileString(path.join(target, "package/tool"))).toBe("installed");
      expect(yield* fs.readDirectory(directory)).toEqual(["tool"]);
    }
    expect(yield* fs.exists(path.join(directory, "outside"))).toBe(false);
    expect(() => npmIntegrity(pin.url, "sha256-abc")).toThrow(ArchiveIntegrityRejected);
  }),
);

it.effect("platform cleanup retries transient errno failures and interruption stops retries", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const busy = PlatformError.systemError({
      _tag: "Busy",
      module: "FileSystem",
      method: "remove",
      cause: { code: "EBUSY" },
    });
    const filesystem = FileSystem.makeNoop({
      remove: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(busy);
        }),
    });
    const context = yield* Layer.build(
      archiveHostLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            NodePath.layer,
            Layer.succeed(FileSystem.FileSystem, filesystem),
          ),
        ),
      ),
    );
    const host = Context.get(context, ArchiveHost);
    const exhausted = yield* Effect.forkChild(Effect.flip(host.cleanup(staging)));
    yield* TestClock.adjust("11 seconds");
    expect((yield* Fiber.join(exhausted)).reason).toEqual(
      ArchiveInstallFailedReason.cases.HostOperationFailed.make({
        operation: "cleanup",
        cause: busy,
      }),
    );
    expect(attempts).toBe(11);
    attempts = 0;
    const cancelled = yield* Effect.forkChild(host.cleanup(staging));
    yield* TestClock.adjust("600 millis");
    yield* Fiber.interrupt(cancelled);
    assertTrue(Exit.hasInterrupts(yield* Fiber.await(cancelled)));
    const before = attempts;
    yield* TestClock.adjust("20 seconds");
    expect(attempts).toBe(before);
  }),
);
