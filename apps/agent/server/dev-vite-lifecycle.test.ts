import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | null = null;
let root: string | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

test("SSR HMR replaces a module but leaves its old global owner alive", async () => {
  root = mkdtempSync(join(tmpdir(), "agent-vite-hmr-"));
  const moduleFile = join(root, "entry.ts");
  const hookEvents: string[] = [];
  const ownerKey = `__context_agent_hmr_test_${randomUUID()}`;
  const source = (revision: number) =>
    `export const revision = ${revision};\nexport const owner = (globalThis[${JSON.stringify(ownerKey)}] ??= {revision});\n`;
  writeFileSync(moduleFile, source(1));
  server = await createServer({
    configFile: false,
    root,
    appType: "custom",
    server: { middlewareMode: true },
    plugins: [
      {
        name: "probe-ssr-hmr",
        hotUpdate: ({ file }) => {
          hookEvents.push(file);
        },
      },
    ],
  });
  const first = await server.ssrLoadModule("/entry.ts");
  expect(first.revision).toBe(1);
  writeFileSync(moduleFile, source(2));
  const activeServer = server;
  await expect
    .poll(async () => (await activeServer.ssrLoadModule("/entry.ts")).revision, {
      timeout: 8_000,
      interval: 20,
    })
    .toBe(2);
  const next = await server.ssrLoadModule("/entry.ts");
  expect(first.revision).toBe(1);
  expect(next.owner).toBe(first.owner);
  expect(next.owner.revision).toBe(1);
  expect(
    hookEvents.some((file) => file.endsWith("/entry.ts")),
    JSON.stringify(hookEvents),
  ).toBe(true);
}, 12_000);

test("pending hotUpdate does not prevent concurrent SSR import of changed code", async () => {
  root = mkdtempSync(join(tmpdir(), "agent-vite-drain-"));
  const moduleFile = join(root, "entry.ts");
  writeFileSync(moduleFile, "export const revision = 1;\n");
  let hookEntered = false;
  let resumeHook: (() => void) | undefined;
  const pendingHook = new Promise<void>((resolve) => {
    resumeHook = resolve;
  });
  server = await createServer({
    configFile: false,
    root,
    appType: "custom",
    server: { middlewareMode: true },
    plugins: [
      {
        name: "probe-ssr-drain",
        async hotUpdate({ file }) {
          if (file.endsWith("/entry.ts")) {
            hookEntered = true;
            await pendingHook;
          }
        },
      },
    ],
  });
  try {
    expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(1);
    writeFileSync(moduleFile, "export const revision = 2;\n");
    await expect.poll(() => hookEntered, { timeout: 8_000, interval: 20 }).toBe(true);
    // Actual Vite invalidates before the pending hook resolves; no proposed owner gate is needed.
    expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(2);
  } finally {
    resumeHook?.();
  }
}, 12_000);

test("watch.ignored alone does not isolate SSR modules from changed source", async () => {
  root = mkdtempSync(join(tmpdir(), "agent-vite-isolated-"));
  const moduleFile = join(root, "entry.ts");
  writeFileSync(moduleFile, "export const revision = 1;\n");
  const config = {
    configFile: false as const,
    root,
    appType: "custom" as const,
    server: { middlewareMode: true as const, watch: { ignored: [moduleFile] } },
  };
  server = await createServer(config);
  expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(1);
  writeFileSync(moduleFile, "export const revision = 2;\n");
  // Vite's SSR module graph still invalidates despite Chokidar's ignored option.
  const activeServer = server;
  await expect
    .poll(async () => (await activeServer.ssrLoadModule("/entry.ts")).revision, {
      timeout: 8_000,
      interval: 20,
    })
    .toBe(2);
}, 12_000);

test("closing a Vite watcher keeps cached SSR code but does not freeze lazy imports", async () => {
  root = mkdtempSync(join(tmpdir(), "agent-vite-frozen-"));
  const moduleFile = join(root, "entry.ts");
  const lazyFile = join(root, "lazy.ts");
  writeFileSync(moduleFile, "export const revision = 1;\n");
  writeFileSync(lazyFile, "export const revision = 1;\n");
  const config = {
    configFile: false as const,
    root,
    appType: "custom" as const,
    server: { middlewareMode: true as const },
  };
  server = await createServer(config);
  expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(1);
  await server.watcher.close();
  writeFileSync(moduleFile, "export const revision = 2;\n");
  writeFileSync(lazyFile, "export const revision = 2;\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(1);
  // No watcher can invalidate a module that the old worker has never imported.
  // It reads current source on its first import, even while its old owner is alive.
  expect((await server.ssrLoadModule("/lazy.ts")).revision).toBe(2);
  await server.close();
  server = await createServer(config);
  expect((await server.ssrLoadModule("/entry.ts")).revision).toBe(2);
}, 12_000);
