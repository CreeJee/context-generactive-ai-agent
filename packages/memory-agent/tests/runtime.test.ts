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
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CodexAccount } from "../src/codex/account.ts";
import { CodexAppServer, targetTriple } from "../src/codex/app-server.ts";
import { codexManifestFile } from "../src/codex/installer.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { installArchive, npmIntegrity, type PinnedArchive } from "../src/runtime/archive.ts";
import { requireRuntime } from "../src/runtime/resources.ts";
import { tgz, type TarEntry } from "./support/tgz.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
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
    expect(await installArchive(wrongPin, target)).toBe("checksum_mismatch");
    expect(await installArchive(pinned(url("/missing.tgz"), good), target)).toBe("download_failed");
    expect(await installArchive(pinned(url("/escaping.tgz"), escaping), target)).toBe(
      "unsafe_archive",
    );
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

describe("codex in the executable", () => {
  test("is fetched on first need while sign-in reports installing, then starts from the storage root", async () => {
    const triple = targetTriple(process.platform, process.arch);
    if (!triple) throw new Error("unsupported test platform");
    // Stands in for the platform package: a codex that runs the fake app server.
    const archive = tgz([
      {
        name: `package/vendor/${triple}/bin/codex`,
        content: `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" --signed-in "$@"\n`,
        mode: 0o755,
      },
    ]);
    const url = await archiveServer({ "/codex.tgz": archive });
    const runtime = tempDir();
    const storage = tempDir();
    writeFileSync(
      join(runtime, codexManifestFile),
      JSON.stringify({
        version: "0.0.0-test",
        triple,
        url: url("/codex.tgz"),
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      }),
    );
    process.env.CONTEXT_AGENT_RUNTIME = runtime;
    cleanups.push(() => void delete process.env.CONTEXT_AGENT_RUNTIME);

    const app = ManagedRuntime.make(
      CodexAccount.layer.pipe(
        Layer.provideMerge(CodexAppServer.layer),
        Layer.provide(StorageRoot.layer(storage)),
      ),
    );
    cleanups.push(() => app.dispose());
    const status = () => app.runPromise(Effect.flatMap(CodexAccount, (account) => account.status));

    expect(await status()).toEqual({ status: "installing" });
    let state = await status();
    for (let attempt = 0; attempt < 100 && state.status === "installing"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await status();
    }
    expect(state).toEqual({ status: "signed-in", planType: "plus" });
    expect(
      existsSync(join(storage, "runtime", `codex-0.0.0-test-${process.platform}-${process.arch}`)),
    ).toBe(true);
  });
});
