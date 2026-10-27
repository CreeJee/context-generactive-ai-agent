import { FetchHttpClient, HttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { ManagedRuntime, Path } from "effect";
import { Cause, Clock, Config, Console, Effect, Exit, FileSystem, Layer } from "effect";
import { DateTime, Ref, Sink, Stdio, Stream } from "effect";
import { nativePromise } from "memory-agent/native-effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { Option, Schema } from "effect";
import { developmentBuildId } from "../server/dev-safety.ts";
import { devHelp, readDevConfiguration } from "./dev-configuration.ts";
import { assertPortAvailable } from "./dev-process.ts";

const developmentRuntime = ManagedRuntime.make(
  Layer.merge(NodeServices.layer, FetchHttpClient.layer),
);
const nodePath = await developmentRuntime.runPromise(Path.Path);
const { dirname } = nodePath;
const app = await developmentRuntime.runPromise(
  nodePath.fromFileUrl(new URL("..", import.meta.url)),
);
// Validate CLI/environment settings before any build, process or storage mutation.
const configuration = await developmentRuntime.runPromise(
  readDevConfiguration(process.argv.slice(2), process.env, app).pipe(
    Effect.catchTag("DevConfigurationError", (failure) =>
      Effect.andThen(
        Console.error(failure.message),
        Effect.sync(() => process.exit(1)),
      ),
    ),
  ),
);
if (configuration.help) {
  await developmentRuntime.runPromise(Console.log(devHelp));
  process.exit(0);
}
const { backendPort, webPort, manifestFile, mode, spans } = configuration;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const backendLogDirectory = nodePath.join(app, "build", "logs");

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

/** The backend's `OTEL_*` variables for the local collector; the caller's own otherwise. */
const spanExport = () => {
  switch (spans.kind) {
    case "local":
      return {
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${spans.port}`,
      };
    case "off":
      return {};
  }
};

/** The profiling tool's OTLP collector, appending the backend's spans to `file`. */
const spanCollector = Effect.fnUntraced(function* (port: number, file: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = nodePath.join(app, "..", "..");
  return yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        nodePath.join(root, "tools", "profile", "main.ts"),
        "collect-otlp",
        "--port",
        String(port),
        "--out",
        file,
        "--until-stdin-closes",
      ],
      // The open stdin pipe is the collector's lifetime: it ends when this process does, even
      // if this process is killed before its own shutdown reaches the collector.
      { cwd: root, stdin: "pipe", stdout: "inherit", stderr: "inherit", forceKillAfter: 5_000 },
    ),
  );
});

const stableBackend = Effect.fnUntraced(function* (buildId: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = [
    // Node warnings (listener leaks, deprecations) carry their stack into the backend log.
    "--trace-warnings",
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
      env: { CONTEXT_AGENT_BUILD_ID: buildId, ...spanExport() },
      extendEnv: true,
      // The open stdin pipe is the backend's lifetime, as with the span collector.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: 5_000,
    }),
  );
});

/**
 * The backend's output, shown here as before and written to a log file of its own for each start,
 * so one file never holds every run. A failed file write stops only the file copy: the terminal
 * keeps draining the backend's pipes.
 */
const recordBackendOutput = Effect.fnUntraced(function* (
  backend: ChildProcessSpawner.ChildProcessHandle,
  buildId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const started = DateTime.formatIso(yield* DateTime.now).replaceAll(/[:.]/gu, "-");
  const path = nodePath.join(backendLogDirectory, `dev-backend-${backendPort}-${started}.log`);
  yield* fs.makeDirectory(backendLogDirectory, { recursive: true });
  const file = yield* fs.open(path, { flag: "wx" });
  const writing = yield* Ref.make(true);
  const toFile = (chunk: Uint8Array) =>
    Effect.when(
      file
        .writeAll(chunk)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            Ref.set(writing, false).pipe(
              Effect.andThen(Console.error(`Backend log file stopped: ${error.message}`)),
            ),
          ),
        ),
      Ref.get(writing),
    );
  yield* toFile(new TextEncoder().encode(`=== backend ${buildId} ===\n`));
  const copy = <E, R>(
    output: Stream.Stream<Uint8Array, E>,
    terminal: Sink.Sink<void, Uint8Array, never, E, R>,
  ) => output.pipe(Stream.tap(toFile), Stream.run(terminal));
  yield* Effect.forkScoped(
    Effect.all(
      [
        copy(backend.stdout, stdio.stdout({ endOnDone: false })),
        copy(backend.stderr, stdio.stderr({ endOnDone: false })),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  );
  return path;
});

function webFrontend(manifest: typeof Manifest.Type) {
  return packageCommand(
    // Same address as the backend: Vite's default `localhost` binds only IPv6 [::1] on macOS, so
    // 127.0.0.1 did not reach the frontend. Browsers still reach it as `localhost` over IPv4.
    [
      "exec",
      "react-router",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
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
  yield* assertPortAvailable(webPort, "127.0.0.1", "Frontend");
  const manifest = yield* readManifest();
  yield* waitForBackend(manifest.backendUrl, manifest.buildId);
  yield* Console.log(`Stable agent backend: ${manifest.backendUrl}`);
  const web = yield* webFrontend(manifest);
  process.exitCode = yield* web.exitCode;
});

const runWithBackend = Effect.fn("dev.runWithBackend")(function* (includeWeb: boolean) {
  yield* assertPortAvailable(backendPort, "127.0.0.1", "Backend");
  if (includeWeb) yield* assertPortAvailable(webPort, "127.0.0.1", "Frontend");
  if (spans.kind === "local") yield* assertPortAvailable(spans.port, "127.0.0.1", "Span collector");
  const buildId = yield* nativePromise(() => developmentBuildId(app));
  yield* buildBackend(buildId);
  const collector = spans.kind === "local" ? yield* spanCollector(spans.port, spans.file) : null;
  if (spans.kind === "local") yield* Console.log(`Collecting spans into ${spans.file}`);
  const backend = yield* stableBackend(buildId);
  yield* Console.log(`Backend log: ${yield* recordBackendOutput(backend, buildId)}`);
  let web: ChildProcessSpawner.ChildProcessHandle | null = null;
  let stopping = false;
  const shutdown = Effect.fn("dev.shutdown")(function* (signal: ChildProcess.Signal) {
    if (stopping) return;
    stopping = true;
    yield* Effect.forEach([web, backend], (child) => stop(child, signal), {
      concurrency: "unbounded",
      discard: true,
    });
    // After the backend: its runtime exports the last spans as it stops.
    yield* stop(collector, signal);
    yield* removeManifest(buildId);
  });
  // A second Ctrl+C while the children drain kills them now instead of leaving them behind.
  const forceStop = Effect.forEach([web, backend, collector], (child) => stop(child, "SIGKILL"), {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.andThen(removeManifest(buildId)));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map(
    (signal) => () => void developmentRuntime.runPromise(stopping ? forceStop : shutdown(signal)),
  );
  signals.forEach((signal, index) => process.on(signal, handlers[index]!));
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
  yield* Console.log(`HMR frontend: http://127.0.0.1:${webPort}`);
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
if (Exit.isFailure(developmentExit)) {
  await developmentRuntime.runPromise(Console.error(Cause.pretty(developmentExit.cause)));
  process.exitCode = 1;
}
