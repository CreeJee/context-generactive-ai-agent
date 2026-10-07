import { NodeCrypto } from "@effect/platform-node";
import { createServer, type RequestListener, type Server } from "node:http";
import { it } from "@effect/vitest";
import { Cause, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { installArchive, npmIntegrity, type PinnedArchive } from "../src/runtime/archive.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { tgz, type TarEntry } from "./support/tgz.ts";

afterEach(() => vi.unstubAllEnvs());
const sdkCall = Effect.fn("runtimeTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(Effect.uninterruptible);
});
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
const closeServer = Effect.fn("runtimeTest.closeServer")(function* (server: Server) {
  if (!server.listening) return;
  yield* Effect.callback<void, Cause.UnknownError>((resume) => {
    server.close((error) =>
      resume(error === undefined ? Effect.void : Effect.fail(new Cause.UnknownError(error))),
    );
    server.closeAllConnections();
  });
});
// Listen on a real native TCP endpoint, but wait for its closure before fixture storage is removed.
const listeningServer = Effect.fn("runtimeTest.listeningServer")(function* (
  handler?: RequestListener,
) {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer(handler)),
    (server) => closeServer(server).pipe(Effect.orDie),
  );
  yield* Effect.callback<void, Cause.UnknownError>((resume) => {
    const fail = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.off("error", fail);
    });
  });
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address(),
  );
  return { server, port: address.port };
});
const archiveServer = Effect.fn("runtimeTest.archiveServer")(function* (
  files: Record<string, Buffer>,
) {
  const { port } = yield* listeningServer((request, response) => {
    const body = files[request.url ?? ""];
    if (body === undefined) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/gzip" }).end(body);
  });
  return (path: string) => "http://127.0.0.1:" + port + path;
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
        const real = requireRuntime("turbovec").loadTurbovec();
        expect(real.VectorIndex).toBeTypeOf("function");
        vi.stubEnv("CONTEXT_AGENT_RUNTIME", runtime);
        // The stand-in returns a marker string where the real addon returns its classes.
        expect(requireRuntime("turbovec").loadTurbovec()).toEqual("from the runtime folder");
      }).pipe(withCrypto, withTestPlatform),
  );
});

describe("installArchive", () => {
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
        expect(
          yield* Effect.gen(function* () {
            const pin = yield* pinned(url("/tool.tgz"), bytes);
            return yield* sdkCall(() => installArchive(pin, target));
          }),
        ).toBeNull();
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
        expect(yield* sdkCall(() => installArchive(wrongPin, target))).toMatchObject({
          reason: "checksum_mismatch",
        });
        expect(
          yield* Effect.gen(function* () {
            const pin = yield* pinned(url("/missing.tgz"), good);
            return yield* sdkCall(() => installArchive(pin, target));
          }),
        ).toEqual({
          reason: "download_failed",
          detail: "HTTP 404",
        });
        expect(
          yield* Effect.gen(function* () {
            const pin = yield* pinned(url("/escaping.tgz"), escaping);
            return yield* sdkCall(() => installArchive(pin, target));
          }),
        ).toEqual({
          reason: "unsafe_archive",
          detail: "../outside",
        });
        // The log says why a download failed, not only that fetch did.
        const { server: closed, port } = yield* listeningServer();
        yield* closeServer(closed);
        expect(
          yield* Effect.gen(function* () {
            const pin = yield* pinned(`http://127.0.0.1:${port}/x.tgz`, good);
            return yield* sdkCall(() => installArchive(pin, target));
          }),
        ).toMatchObject({
          reason: "download_failed",
          detail: expect.stringContaining("ECONNREFUSED"),
        });
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
