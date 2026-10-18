import { FetchHttpClient, HttpClient } from "effect/http";
import { NodePath, NodeServices } from "@effect/platform-node";
import { ManagedRuntime, Path } from "effect";
import { Cause, Clock, Config, Console, Effect, FileSystem, Layer } from "effect";
import { nativePromise } from "memory-agent/native-effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { Option, Schema } from "effect";
import { developmentBuildId } from "../server/dev-safety.ts";
import { devHelp, readDevConfiguration } from "./dev-configuration.ts";
import { assertPortAvailable } from "./dev-process.ts";

const nodePath = ManagedRuntime.make(NodePath.layer).runSync(Path.Path);
const { dirname } = nodePath;

const developmentRuntime = ManagedRuntime.make(
  Layer.merge(NodeServices.layer, FetchHttpClient.layer),
);
const app = await developmentRuntime.runPromise(
  nodePath.fromFileUrl(new URL("..", import.meta.url)),
);
// Validate CLI/environment settings before any build, process or storage mutation.
const configuration = await developmentRuntime.runPromise(
  readDevConfiguration(process.argv.slice(2), process.env, app).pipe(
    Effect.catchTag("DevConfigurationError", (failure) =>
      Effect.sync(() => {
        Effect.runSync(Console.error(failure.message));
        process.exit(1);
      }),
    ),
  ),
);
if (configuration.help) {
  Effect.runSync(Console.log(devHelp));
  process.exit(0);
}
const { backendPort, webPort, manifestFile, mode } = configuration;
const backendUrl = `http://127.0.0.1:${backendPort}`;

const Manifest = Schema.Struct({
  backendUrl: Schema.String,
  buildId: Schema.String,
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

const packageCommand = Effect.fnUntraced(function* (
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const options = {
    cwd: app,
    env,
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    forceKillAfter: 5_000,
  } as const;
  if (args[0] === "exec" && args[1] === "vp")
    return yield* spawner.spawn(
      ChildProcess.make("vp", args.slice(2), { ...options, shell: process.platform === "win32" }),
    );
  const npmExecPath = Option.getOrUndefined(yield* Config.option(Config.String("npm_execpath")));
  return yield* spawner.spawn(
    npmExecPath !== undefined && npmExecPath.length > 0
      ? ChildProcess.make(process.execPath, [npmExecPath, ...args], options)
      : ChildProcess.make("pnpm", args, { ...options, shell: process.platform === "win32" }),
  );
});

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const run = Effect.fn("dev.run")(function* (
  args: readonly string[],
  env: Record<string, string>,
  label: string,
) {
  const code = yield* (yield* packageCommand(args, env)).exitCode;
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
    const response = yield* HttpClient.get(`${url}/api/health`).pipe(
      Effect.timeoutOption(1_000),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(response)) {
      const body = yield* response.value.json.pipe(Effect.option);
      if (
        response.value.status >= 200 &&
        response.value.status < 300 &&
        Option.isSome(body) &&
        Schema.is(Health)(body.value) &&
        body.value.buildId === expectedBuildId &&
        body.value.status === "ready"
      )
        return;
    }
    yield* Effect.sleep(100);
  }
  return yield* new Cause.UnknownError(new Error(`stable backend did not become ready at ${url}`));
});

const writeManifest = Effect.fn("dev.writeManifest")(function* (manifest: typeof Manifest.Type) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(manifestFile), { recursive: true });
  const temporary = `${manifestFile}.${process.pid}.tmp`;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))(manifest);
  yield* fs.writeFileString(temporary, encoded, { mode: 0o600 });
  yield* fs.rename(temporary, manifestFile);
});

const readManifest = Effect.fn("dev.readManifest")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const manifest = Option.getOrNull(decodeManifest(yield* fs.readFileString(manifestFile)));
  if (manifest === null)
    return yield* new Cause.UnknownError(
      new Error(
        "dev backend manifest is invalid; run vp run dev:agent with the same backend-port/manifest first",
      ),
    );
  return manifest;
});

const removeManifest = Effect.fn("dev.removeManifest")(function* (buildId: string) {
  const fs = yield* FileSystem.FileSystem;
  const current = Option.getOrNull(decodeManifest(yield* fs.readFileString(manifestFile)));
  if (current?.buildId === buildId) yield* fs.remove(manifestFile, { force: true });
}, Effect.ignore());

const stableBackend = Effect.fnUntraced(function* (buildId: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = [
    "dist/context-agent.mjs",
    "--port",
    String(backendPort),
    "--no-open",
    "--dev-backend",
  ];
  if (configuration.storage !== undefined) args.push("--storage", configuration.storage);
  return yield* spawner.spawn(
    ChildProcess.make(process.execPath, args, {
      cwd: app,
      env: { CONTEXT_AGENT_BUILD_ID: buildId },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      forceKillAfter: 5_000,
    }),
  );
});

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
  yield* Console.log("Building the stable agent backend (HMR disabled)...");
  yield* run(["exec", "react-router", "build"], env, "react-router build");
  yield* run(["exec", "vp", "pack"], env, "vp pack");
});

const stop = Effect.fn("dev.stop")(function* (
  child: ChildProcessSpawner.ChildProcessHandle | null,
  signal: ChildProcess.Signal,
) {
  if (child === null || !(yield* child.isRunning)) return;
  yield* child.kill({ killSignal: signal, forceKillAfter: 5_000 });
}, Effect.ignore());

const runWebOnly = Effect.fn("dev.runWebOnly")(function* () {
  yield* assertPortAvailable(webPort, "localhost", "Frontend");
  const manifest = yield* readManifest();
  yield* waitForBackend(manifest.backendUrl, manifest.buildId);
  yield* Console.log(`Stable agent backend: ${manifest.backendUrl}`);
  const web = yield* webFrontend(manifest);
  process.exitCode = yield* web.exitCode;
});

const runWithBackend = Effect.fn("dev.runWithBackend")(function* (includeWeb: boolean) {
  yield* assertPortAvailable(backendPort, "127.0.0.1", "Backend");
  if (includeWeb) yield* assertPortAvailable(webPort, "localhost", "Frontend");
  const buildId = yield* nativePromise(() => developmentBuildId(app));
  yield* buildBackend(buildId);
  const backend = yield* stableBackend(buildId);
  let web: ChildProcessSpawner.ChildProcessHandle | null = null;
  let stopping = false;
  const shutdown = Effect.fn("dev.shutdown")(function* (signal: ChildProcess.Signal) {
    if (stopping) return;
    stopping = true;
    yield* Effect.forEach([web, backend], (child) => stop(child, signal), {
      concurrency: "unbounded",
      discard: true,
    });
    yield* removeManifest(buildId);
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map(
    (signal) => () => void developmentRuntime.runPromise(shutdown(signal)),
  );
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
  yield* Effect.raceFirst(
    waitForBackend(backendUrl, buildId),
    backend.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new Cause.UnknownError(
            new Error(`stable backend exited before startup with code ${code}`),
          ),
        ),
      ),
    ),
  );
  yield* writeManifest({ backendUrl, buildId });
  yield* Console.log(`Stable agent backend: ${backendUrl}`);
  if (!includeWeb) {
    process.exitCode = yield* backend.exitCode.pipe(
      Effect.catchCause((cause) => (stopping ? Effect.succeed(0) : Effect.failCause(cause))),
    );
    return;
  }
  web = yield* webFrontend({ backendUrl, buildId });
  yield* Console.log(`HMR frontend: http://localhost:${webPort}`);
  const first = yield* Effect.raceFirst(
    backend.exitCode.pipe(Effect.map((code) => ({ child: "backend", code }))),
    web.exitCode.pipe(Effect.map((code) => ({ child: "web", code }))),
  ).pipe(
    Effect.catchCause((cause) =>
      stopping ? Effect.succeed({ child: "backend", code: 0 }) : Effect.failCause(cause),
    ),
  );
  process.exitCode = first.code;
}, Effect.scoped);

const developmentExit = await developmentRuntime.runPromiseExit(
  mode === "web" ? Effect.scoped(runWebOnly()) : runWithBackend(mode === "all"),
);
if (developmentExit._tag === "Failure") {
  Effect.runSync(Console.error(Cause.pretty(developmentExit.cause)));
  process.exitCode = 1;
}
