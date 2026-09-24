import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Option, Schema } from "effect";
import { developmentBuildId } from "../server/dev-safety.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const backendPort = Number(process.env.CONTEXT_AGENT_DEV_BACKEND_PORT ?? "5180");
const webPort = Number(process.env.CONTEXT_AGENT_DEV_WEB_PORT ?? "5173");
const backendUrl = `http://127.0.0.1:${backendPort}`;
const manifestFile = join(app, "build", "dev-backend.json");

const Mode = Schema.Literals(["all", "agent", "web"]);
const mode = Schema.decodeUnknownSync(Mode)(process.argv[2] ?? "all");

const Manifest = Schema.Struct({
  backendUrl: Schema.String,
  buildId: Schema.String,
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

function packageCommand(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? spawn(process.execPath, [npmExecPath, ...args], {
        cwd: app,
        env: { ...process.env, ...env },
        stdio: "inherit",
      })
    : spawn("pnpm", args, {
        cwd: app,
        env: { ...process.env, ...env },
        stdio: "inherit",
        shell: process.platform === "win32",
      });
}

function completion(child: ChildProcess, label: string) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${label} stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function run(args: readonly string[], env: NodeJS.ProcessEnv, label: string) {
  const code = await completion(packageCommand(args, env), label);
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

async function waitForBackend(url: string, expectedBuildId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body: unknown = await response.json();
      const Health = Schema.Struct({
        buildId: Schema.String,
        status: Schema.Literals(["ready", "draining"]),
      });
      if (response.ok && Schema.is(Health)(body) && body.buildId === expectedBuildId) return;
    } catch {
      // The stable backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`stable backend did not become ready at ${url}`);
}

function writeManifest(manifest: typeof Manifest.Type) {
  const temporary = `${manifestFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
  renameSync(temporary, manifestFile);
}

function readManifest() {
  const manifest = Option.getOrNull(decodeManifest(readFileSync(manifestFile, "utf8")));
  if (manifest === null)
    throw new Error("dev backend manifest is invalid; run pnpm dev:agent first");
  return manifest;
}

function removeManifest(buildId: string) {
  try {
    const current = Option.getOrNull(decodeManifest(readFileSync(manifestFile, "utf8")));
    if (current?.buildId === buildId) rmSync(manifestFile, { force: true });
  } catch {
    // A newer backend owns the manifest, or it is already absent.
  }
}

function stableBackend(buildId: string) {
  const args = [
    "dist/context-agent.mjs",
    "--port",
    String(backendPort),
    "--no-open",
    "--dev-backend",
  ];
  if (process.env.CONTEXT_AGENT_HOME) args.push("--storage", process.env.CONTEXT_AGENT_HOME);
  return spawn(process.execPath, args, {
    cwd: app,
    env: { ...process.env, CONTEXT_AGENT_BUILD_ID: buildId },
    stdio: "inherit",
  });
}

function webFrontend(manifest: typeof Manifest.Type) {
  return packageCommand(
    ["exec", "react-router", "dev", "--port", String(webPort), "--strictPort"],
    {
      CONTEXT_AGENT_DEV_BACKEND: manifest.backendUrl,
      CONTEXT_AGENT_BUILD_ID: manifest.buildId,
    },
  );
}

async function buildBackend(buildId: string) {
  const env = { CONTEXT_AGENT_BUILD_ID: buildId };
  console.log("Building the stable agent backend (HMR disabled)...");
  await run(["exec", "react-router", "build"], env, "react-router build");
  await run(["exec", "vp", "pack"], env, "vp pack");
}

async function stop(child: ChildProcess | null, signal: NodeJS.Signals) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    completion(child, "child process").catch(() => undefined),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function runWebOnly() {
  const manifest = readManifest();
  await waitForBackend(manifest.backendUrl, manifest.buildId);
  console.log(`Stable agent backend: ${manifest.backendUrl}`);
  const web = webFrontend(manifest);
  process.exitCode = await completion(web, "HMR frontend");
}

async function runWithBackend(includeWeb: boolean) {
  const buildId = developmentBuildId(app);
  await buildBackend(buildId);
  const backend = stableBackend(buildId);
  let web: ChildProcess | null = null;
  let stopping = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    await Promise.all([stop(web, signal), stop(backend, signal)]);
    removeManifest(buildId);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void shutdown(signal));

  try {
    await waitForBackend(backendUrl, buildId);
    writeManifest({ backendUrl, buildId });
    console.log(`Stable agent backend: ${backendUrl}`);

    if (!includeWeb) {
      process.exitCode = await completion(backend, "stable backend");
      return;
    }

    web = webFrontend({ backendUrl, buildId });
    console.log(`HMR frontend: http://127.0.0.1:${webPort}`);
    const first = await Promise.race([
      completion(backend, "stable backend").then((code) => ({ child: "backend", code })),
      completion(web, "HMR frontend").then((code) => ({ child: "web", code })),
    ]);
    process.exitCode = first.code;
    await shutdown("SIGTERM");
  } finally {
    removeManifest(buildId);
  }
}

try {
  if (mode === "web") await runWebOnly();
  else await runWithBackend(mode === "all");
} catch (error) {
  console.error(error instanceof Error ? error.message : "development server failed");
  process.exitCode = 1;
}
