import { expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path } from "effect";
import {
  ArchiveHost,
  ArchiveInstaller,
  ArchiveInstallFailed,
  type PinnedArchive,
} from "../src/runtime/archive-install.ts";
import {
  archiveHostLayer,
  ArchiveIntegrityRejected,
  npmIntegrity,
} from "../src/runtime/archive.ts";
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
      yield* Effect.result(install({ ...mismatch.host, checksum: () => Effect.succeed("wrong") })),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ArchiveInstallFailed", reason: { _tag: "ChecksumMismatch" } },
    });
    expect(mismatch.calls).toEqual(["download"]);
    const unsafe = fixture();
    expect(
      yield* Effect.result(install({ ...unsafe.host, list: () => Effect.succeed("../outside\n") })),
    ).toMatchObject({
      _tag: "Failure",
      failure: { reason: { _tag: "UnsafeEntry", entry: "../outside" } },
    });
    expect(unsafe.calls).toEqual(["download", "checksum", "stage", "write", "cleanup"]);
  }),
);

it.effect("extract and cleanup failures remain typed; interruption waits for cleanup", () =>
  Effect.gen(function* () {
    const failed = fixture();
    const error = ArchiveInstallFailed.make({
      reason: { _tag: "HostOperationFailed", operation: "extract", cause: "tar failed" },
    });
    expect(
      yield* Effect.result(install({ ...failed.host, extract: () => Effect.fail(error) })),
    ).toMatchObject({
      _tag: "Failure",
      failure: error,
    });
    expect(failed.calls.at(-1)).toBe("cleanup");
    expect(failed.calls).not.toContain("publish");
    const cleanupError = ArchiveInstallFailed.make({
      reason: { _tag: "HostOperationFailed", operation: "cleanup", cause: "busy" },
    });
    expect(
      yield* Effect.result(
        install({ ...fixture().host, cleanup: () => Effect.fail(cleanupError) }),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: cleanupError,
    });
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
      Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, archiveHostLayer),
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
      yield* Effect.result(installer.install({ archive: { ...pin, digest: "wrong" }, target })),
    ).toMatchObject({
      _tag: "Failure",
      failure: { reason: { _tag: "ChecksumMismatch" } },
    });
    expect(yield* fs.readFileString(path.join(target, "old"))).toBe("old");
    yield* installer.install({ archive: { ...pin, digest }, target });
    expect(yield* fs.readFileString(path.join(target, "package/tool"))).toBe("installed");
    expect(yield* fs.readDirectory(directory)).toEqual(["tool"]);
    for (const rejected of [
      { bytes: tgz([{ name: "../outside", content: "escape" }]), reason: "UnsafeEntry" },
      { bytes: new Uint8Array([1, 2, 3]), reason: "HostOperationFailed" },
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
      expect(
        yield* Effect.result(
          Context.get(rejectedContext, ArchiveInstaller).install({
            archive: { ...pin, digest: rejectedDigest },
            target,
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: rejected.reason } } });
      expect(yield* fs.readFileString(path.join(target, "package/tool"))).toBe("installed");
      expect(yield* fs.readDirectory(directory)).toEqual(["tool"]);
    }
    expect(yield* fs.exists(path.join(directory, "outside"))).toBe(false);
    expect(() => npmIntegrity(pin.url, "sha256-abc")).toThrow(ArchiveIntegrityRejected);
  }),
);
