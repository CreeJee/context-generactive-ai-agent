import { NodeCrypto } from "@effect/platform-node";
import { testHttpServer, HttpServerRequest, HttpServerResponse } from "./support/http.ts";
import { Scope, Exit } from "effect";
import { it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import {
  ArchiveInstaller,
  archiveInstallerLayer,
  npmIntegrity,
  type PinnedArchive,
} from "../src/runtime/archive.ts";
import { ArchiveInstallFailedReason } from "../src/runtime/archive-install.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { tgz, type TarEntry } from "./support/tgz.ts";

afterEach(() => vi.unstubAllEnvs());
const install = Effect.fn("runtimeTest.install")(function* (
  archive: PinnedArchive,
  target: string,
) {
  const context = yield* Layer.build(archiveInstallerLayer);
  return yield* Context.get(context, ArchiveInstaller).install({ archive, target });
});
const rejection = (archive: PinnedArchive, target: string) =>
  Effect.map(Effect.flip(install(archive, target)), (failure) => failure.reason);
const withCrypto = Effect.fn("runtimeTest.withCrypto")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(NodeCrypto.layer);
  return yield* Effect.provideContext(program, services);
});
const tempDir = Effect.fn("runtimeTest.tempDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-runtime-" }));
});
const archiveServer = Effect.fn("runtimeTest.archiveServer")(function* (
  files: Record<string, Buffer>,
) {
  const { url } = yield* testHttpServer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = files[request.url];
      return body === undefined
        ? HttpServerResponse.empty({ status: 404 })
        : HttpServerResponse.uint8Array(body, { contentType: "application/gzip" });
    }),
  );
  return (path: string) => url + path;
});
const pinned = Effect.fn("runtimeTest.pinned")(function* (url: string, bytes: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const pin: PinnedArchive = {
    url,
    algorithm: "sha256",
    digest: Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex"),
  };
  return pin;
});

describe("runtime packages", () => {
  it.live(
    "load from the unpacked runtime folder when the executable names one, else from this package",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtime = yield* tempDir();
        yield* fs.makeDirectory(path.join(runtime, "node_modules", "turbovec"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(runtime, "node_modules", "turbovec", "package.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            name: "turbovec",
            type: "module",
            exports: "./index.js",
          }),
        );
        yield* fs.writeFileString(
          path.join(runtime, "node_modules", "turbovec", "index.js"),
          'export const loadTurbovec = () => "from the runtime folder";',
        );
        const real = (yield* requireRuntime("turbovec")).loadTurbovec();
        expect(real.VectorIndex).toBeTypeOf("function");
        vi.stubEnv("CONTEXT_AGENT_RUNTIME", runtime);
        // The stand-in returns a marker string where the real addon returns its classes.
        expect((yield* requireRuntime("turbovec")).loadTurbovec()).toEqual(
          "from the runtime folder",
        );
      }).pipe(withCrypto, withTestPlatform),
  );
});

describe("archive installer", () => {
  const files: TarEntry[] = [
    { name: "package/bin/tool", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
  ];

  it.live(
    "installs a matching archive in place, replacing an older folder only once complete",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bytes = tgz(files);
        const url = yield* archiveServer({ "/tool.tgz": bytes });
        const dir = yield* tempDir();
        const target = path.join(dir, "tool");
        yield* fs.makeDirectory(target);
        yield* fs.writeFileString(path.join(target, "old"), "old");
        const pin = yield* pinned(url("/tool.tgz"), bytes);
        yield* install(pin, target);
        expect(yield* fs.readFileString(path.join(target, "package/bin/tool"))).toContain(
          "echo hi",
        );
        expect(yield* fs.exists(path.join(target, "old"))).toBe(false);
        expect(yield* fs.readDirectory(dir)).toEqual(["tool"]);
      }).pipe(withCrypto, withTestPlatform),
  );

  it.live(
    "refuses a download that does not match its pin, a missing file, and paths leaving the folder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const good = tgz(files);
        const escaping = tgz([{ name: "../outside", content: "no" }]);
        const url = yield* archiveServer({ "/tool.tgz": good, "/escaping.tgz": escaping });
        const dir = yield* tempDir();
        const target = path.join(dir, "tool");
        const wrongPin = { ...(yield* pinned(url("/tool.tgz"), good)), digest: "0".repeat(64) };
        expect(yield* rejection(wrongPin, target)).toEqual(
          ArchiveInstallFailedReason.cases.ChecksumMismatch.make({ algorithm: "sha256" }),
        );
        const missingPin = yield* pinned(url("/missing.tgz"), good);
        expect(yield* rejection(missingPin, target)).toEqual(
          ArchiveInstallFailedReason.cases.HttpStatus.make({ status: 404 }),
        );
        const escapingPin = yield* pinned(url("/escaping.tgz"), escaping);
        expect(yield* rejection(escapingPin, target)).toEqual(
          ArchiveInstallFailedReason.cases.UnsafeEntry.make({ entry: "../outside" }),
        );
        // A refused connection is a failed download, not a failure of the host's own steps.
        const listenerScope = yield* Scope.make();
        const { port } = yield* Scope.provide(
          testHttpServer(Effect.succeed(HttpServerResponse.empty())),
          listenerScope,
        );
        yield* Scope.close(listenerScope, Exit.void);
        const closedPin = yield* pinned(`http://127.0.0.1:${port}/x.tgz`, good);
        expect(
          ArchiveInstallFailedReason.guards.DownloadFailed(yield* rejection(closedPin, target)),
        ).toBe(true);
        expect(yield* fs.readDirectory(dir)).toEqual([]);
        expect(yield* fs.exists(path.join(dir, "..", "outside"))).toBe(false);
      }).pipe(withCrypto, withTestPlatform),
  );

  it.live("reads npm lockfile integrity as a sha512 pin", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from("tarball");
      const crypto = yield* Crypto.Crypto;
      const digest = Buffer.from(yield* crypto.digest("SHA-512", bytes));
      const integrity = `sha512-${digest.toString("base64")}`;
      expect(npmIntegrity("https://registry.example/x.tgz", integrity)).toEqual({
        url: "https://registry.example/x.tgz",
        algorithm: "sha512",
        digest: digest.toString("hex"),
      });
    }).pipe(withCrypto, withTestPlatform),
  );
});
