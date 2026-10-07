import { Cause, Clock, Effect } from "effect";
import { nativePromise, runNativeEffect } from "memory-agent/native-effect";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../app/truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { spawn, type ChildProcess } from "node:child_process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Option, Schema } from "effect";
import { developmentBuildId } from "../server/dev-safety.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
// Native host/SDK configuration boundary reads or forwards the host environment.
const backendPort = Number(process.env.CONTEXT_AGENT_DEV_BACKEND_PORT ?? "5180");
// Native host/SDK configuration boundary reads or forwards the host environment.
const webPort = Number(process.env.CONTEXT_AGENT_DEV_WEB_PORT ?? "5173");
const backendUrl = `http://127.0.0.1:${backendPort}`;
const manifestFile = join(app, "build", "dev-backend.json");

const Mode = Schema.Literals(["all", "agent", "web"]);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const mode = EffectFunction.flow(
  Schema.decodeUnknownResult(Mode),
  Result.getOrThrow,
)(process.argv[2] ?? "all");

const Manifest = Schema.Struct({
  backendUrl: Schema.String,
  buildId: Schema.String,
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

function packageCommand(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  // Native host/SDK configuration boundary reads or forwards the host environment.
  const npmExecPath = process.env.npm_execpath;
  return isTruthy(npmExecPath)
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
  // Callback-to-Promise handshake for the native caller; cleanup stays at this protocol boundary.
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (isTruthy(signal)) reject(new Error(`${label} stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const run = Effect.fn("dev.run")(function* (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  label: string,
) {
  const code = yield* nativePromise(() => completion(packageCommand(args, env), label));
  if (code !== 0)
    return yield* new Cause.UnknownError(new Error(`${label} failed with exit code ${code}`));
});

const waitForBackend = Effect.fn("dev.waitForBackend")(function* (
  url: string,
  expectedBuildId: string,
) {
  const deadline = (yield* Clock.currentTimeMillis) + 30_000;
  const Health = Schema.Struct({
    buildId: Schema.String,
    status: Schema.Literals(["ready", "draining"]),
  });
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const response = yield* nativePromise(() =>
      fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }),
    ).pipe(Effect.option);
    if (Option.isSome(response)) {
      const body = yield* nativePromise(() => response.value.json()).pipe(Effect.option);
      if (
        response.value.ok &&
        Option.isSome(body) &&
        Schema.is(Health)(body.value) &&
        body.value.buildId === expectedBuildId
      )
        return;
    }
    yield* Effect.sleep(100);
  }
  return yield* new Cause.UnknownError(new Error(`stable backend did not become ready at ${url}`));
});

function writeManifest(manifest: typeof Manifest.Type) {
  mkdirSync(join(app, "build"), { recursive: true });
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
  // Native host/SDK configuration boundary reads or forwards the host environment.
  if (isTruthy(process.env.CONTEXT_AGENT_HOME))
    // Native host/SDK configuration boundary reads or forwards the host environment.
    args.push("--storage", process.env.CONTEXT_AGENT_HOME);
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

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const buildBackend = Effect.fn("dev.buildBackend")(function* (buildId: string) {
  const env = { CONTEXT_AGENT_BUILD_ID: buildId };
  console.log("Building the stable agent backend (HMR disabled)...");
  yield* run(["exec", "vp", "run", "turbovec#build"], env, "turbovec native build");
  yield* run(["exec", "react-router", "build"], env, "react-router build");
  yield* run(["exec", "vp", "pack"], env, "vp pack");
});

const stop = Effect.fn("dev.stop")(function* (child: ChildProcess | null, signal: NodeJS.Signals) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  yield* nativePromise(() => completion(child, "child process")).pipe(
    Effect.ignore,
    Effect.timeoutOption(5_000),
    Effect.tap((result) =>
      Effect.sync(() => {
        if (Option.isNone(result) && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }),
    ),
  );
});

const runWebOnly = Effect.fn("dev.runWebOnly")(function* () {
  const manifest = readManifest();
  yield* waitForBackend(manifest.backendUrl, manifest.buildId);
  console.log(`Stable agent backend: ${manifest.backendUrl}`);
  const web = webFrontend(manifest);
  process.exitCode = yield* nativePromise(() => completion(web, "HMR frontend"));
});

const runWithBackend = Effect.fn("dev.runWithBackend")(function* (includeWeb: boolean) {
  const buildId = developmentBuildId(app);
  yield* buildBackend(buildId);
  const backend = stableBackend(buildId);
  let web: ChildProcess | null = null;
  let stopping = false;
  const shutdown = Effect.fn("dev.shutdown")(function* (signal: NodeJS.Signals) {
    if (stopping) return;
    stopping = true;
    yield* Effect.forEach([web, backend], (child) => stop(child, signal), {
      concurrency: "unbounded",
      discard: true,
    });
    removeManifest(buildId);
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => () => void runNativeEffect(shutdown(signal)));
  signals.forEach((signal, index) => process.once(signal, handlers[index]!));
  yield* Effect.addFinalizer(() =>
    shutdown("SIGTERM").pipe(
      Effect.ensuring(
        Effect.sync(() =>
          signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!)),
        ),
      ),
    ),
  );
  yield* waitForBackend(backendUrl, buildId);
  writeManifest({ backendUrl, buildId });
  console.log(`Stable agent backend: ${backendUrl}`);
  if (!includeWeb) {
    process.exitCode = yield* nativePromise(() => completion(backend, "stable backend"));
    return;
  }
  web = webFrontend({ backendUrl, buildId });
  console.log(`HMR frontend: http://127.0.0.1:${webPort}`);
  const first = yield* nativePromise(() =>
    Promise.race([
      completion(backend, "stable backend").then((code) => ({ child: "backend", code })),
      completion(web!, "HMR frontend").then((code) => ({ child: "web", code })),
    ]),
  );
  process.exitCode = first.code;
}, Effect.scoped);

try {
  if (mode === "web") await runNativeEffect(runWebOnly());
  else await runNativeEffect(runWithBackend(mode === "all"));
} catch (error) {
  // Native stdout/stderr or SDK logging boundary preserves the existing output format.
  console.error(error instanceof Error ? error.message : "development server failed");
  process.exitCode = 1;
}
