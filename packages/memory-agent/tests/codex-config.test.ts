import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { bundledCodex, nativeConfig } from "../src/codex/app-server.ts";

/**
 * Every other codex test runs against the fake app server, which accepts any `-c` line. So a
 * config key that the real codex rejects — a renamed one after a version bump, or one that was
 * never right — passes the whole suite and only fails when a user starts the app. This starts the
 * pinned binary with the exact configuration the app sends and waits for it to answer.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const failure = /Error loading config|invalid type|unknown field|unknown feature key/u;

test("the real codex accepts the configuration this app starts it with", async () => {
  const executable = bundledCodex();
  // Only this machine's platform package is installed; elsewhere there is nothing to check.
  if (!executable) return;

  const home = mkdtempSync(join(tmpdir(), "codex-config-"));
  const child = spawn(
    executable,
    ["app-server", "--listen", "stdio://", ...nativeConfig.flatMap((line) => ["-c", line])],
    { env: { ...process.env, CODEX_HOME: home }, stdio: "pipe" },
  );
  cleanups.push(() => {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "config-test", title: "config test", version: "0" } },
    })}\n`,
  );

  const answered = await new Promise<boolean>((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (output.includes('"id":1') || failure.test(output) || Date.now() - started > 20_000) {
        clearInterval(poll);
        resolve(output.includes('"id":1'));
      }
    }, 100);
  });

  expect(failure.exec(output)?.[0] ?? null).toBeNull();
  expect(answered).toBe(true);
}, 30_000);
