import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { installArchive, npmIntegrity, type PinnedArchive } from "../src/runtime/archive.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { tgz, type TarEntry } from "./support/tgz.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-runtime-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Serves archives by path; anything else is a 404. */
async function archiveServer(files: Record<string, Buffer>) {
  const server: Server = createServer((request, response) => {
    const body = files[request.url ?? ""];
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/gzip" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo;
  return (path: string) => `http://127.0.0.1:${port}${path}`;
}

const pinned = (url: string, bytes: Buffer): PinnedArchive => ({
  url,
  algorithm: "sha256",
  digest: createHash("sha256").update(bytes).digest("hex"),
});

describe("runtime packages", () => {
  test("load from the unpacked runtime folder when the executable names one, else from this package", () => {
    const runtime = tempDir();
    mkdirSync(join(runtime, "node_modules", "turbovec"), { recursive: true });
    writeFileSync(
      join(runtime, "node_modules", "turbovec", "package.json"),
      JSON.stringify({ name: "turbovec", type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(runtime, "node_modules", "turbovec", "index.js"),
      'export const loadTurbovec = () => "from the runtime folder";',
    );

    const real = requireRuntime("turbovec").loadTurbovec();
    expect(real.VectorIndex).toBeTypeOf("function");

    process.env.CONTEXT_AGENT_RUNTIME = runtime;
    cleanups.push(() => void delete process.env.CONTEXT_AGENT_RUNTIME);
    // The stand-in returns a marker string where the real addon returns its classes.
    expect(requireRuntime("turbovec").loadTurbovec()).toEqual("from the runtime folder");
  });
});

describe("installArchive", () => {
  const files: TarEntry[] = [
    { name: "package/bin/tool", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
  ];

  test("installs a matching archive in place, replacing an older folder only once complete", async () => {
    const bytes = tgz(files);
    const url = await archiveServer({ "/tool.tgz": bytes });
    const dir = tempDir();
    const target = join(dir, "tool");
    mkdirSync(target);
    writeFileSync(join(target, "old"), "old");

    expect(await installArchive(pinned(url("/tool.tgz"), bytes), target)).toBeNull();
    expect(readFileSync(join(target, "package/bin/tool"), "utf8")).toContain("echo hi");
    expect(existsSync(join(target, "old"))).toBe(false);
    expect(readdirSync(dir)).toEqual(["tool"]);
  });

  test("refuses a download that does not match its pin, a missing file, and paths leaving the folder", async () => {
    const good = tgz(files);
    const escaping = tgz([{ name: "../outside", content: "no" }]);
    const url = await archiveServer({ "/tool.tgz": good, "/escaping.tgz": escaping });
    const dir = tempDir();
    const target = join(dir, "tool");

    const wrongPin = { ...pinned(url("/tool.tgz"), good), digest: "0".repeat(64) };
    expect(await installArchive(wrongPin, target)).toMatchObject({ reason: "checksum_mismatch" });
    expect(await installArchive(pinned(url("/missing.tgz"), good), target)).toEqual({
      reason: "download_failed",
      detail: "HTTP 404",
    });
    expect(await installArchive(pinned(url("/escaping.tgz"), escaping), target)).toEqual({
      reason: "unsafe_archive",
      detail: "../outside",
    });
    // The log says why a download failed, not only that fetch did.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      await installArchive(pinned(`http://127.0.0.1:${port}/x.tgz`, good), target),
    ).toMatchObject({
      reason: "download_failed",
      detail: expect.stringContaining("ECONNREFUSED"),
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, "..", "outside"))).toBe(false);
  });

  test("reads npm lockfile integrity as a sha512 pin", () => {
    const bytes = Buffer.from("tarball");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(npmIntegrity("https://registry.example/x.tgz", integrity)).toEqual({
      url: "https://registry.example/x.tgz",
      algorithm: "sha512",
      digest: createHash("sha512").update(bytes).digest("hex"),
    });
  });
});
