import { NodeHttpServer, NodePath, NodeServices, NodeSink } from "@effect/platform-node";
import { ManagedRuntime, Path } from "effect";
import { runNativeEffect } from "memory-agent/native-effect";
import { isTruthy } from "../app/truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { createRequestListener } from "@react-router/node";
import { Cause, Console, Effect, FileSystem, Fiber, Option, Schema, Stream } from "effect";
import type { ServerBuild } from "react-router";
import {
  developmentBuildHeader,
  developmentRequestDecision,
  createDevelopmentBoundary,
} from "./dev-safety.ts";

const { extname, resolve, sep } = ManagedRuntime.make(NodePath.layer).runSync(Path.Path);

export interface ServeOptions {
  readonly build: ServerBuild;
  readonly port: number;
  /** React Router's client build (`build/client`). */
  readonly clientDirectory: string;
  /** Present only for the stable development backend behind the HMR frontend. */
  readonly developmentBuildId?: string;
  readonly runtimeInstanceId?: string;
}

/** Only the loopback names; any other Host means a rebinding page is talking to this server (R14). */
const LoopbackHost = Schema.Literals(["127.0.0.1", "localhost", "[::1]"]);

const ClientExtension = Schema.Literals([
  ".js",
  ".css",
  ".json",
  ".svg",
  ".png",
  ".ico",
  ".woff2",
  ".wasm",
  ".map",
]);
const contentTypes = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
} satisfies Record<typeof ClientExtension.Type, string>;

function contentType(file: string) {
  const extension = extname(file);
  return Schema.is(ClientExtension)(extension)
    ? contentTypes[extension]
    : "application/octet-stream";
}

function isLoopbackHost(host: string | undefined) {
  if (!isTruthy(host)) return false;
  try {
    return Schema.is(LoopbackHost)(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** A file of the client build for this path, or null to let React Router answer. */
const clientFile = Effect.fn("serve.clientFile")(function* (
  clientDirectory: string,
  pathname: string,
) {
  const parsed = yield* Effect.try({
    try: () => decodeURIComponent(pathname),
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(Effect.option);
  if (Option.isNone(parsed)) return null;
  const decoded = parsed.value;
  if (decoded.includes("\0")) return null;
  const file = resolve(clientDirectory, `.${decoded}`);
  if (!file.startsWith(clientDirectory + sep)) return null;
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(file).pipe(Effect.option);
  return Option.isSome(stat) && stat.value.type === "File" ? file : null;
});

const browserLauncher = ManagedRuntime.make(NodeServices.layer);
const assetRuntime = ManagedRuntime.make(NodeServices.layer);

export function openInBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  void browserLauncher.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        }),
      );
      yield* child.unref.pipe(Effect.asVoid);
      yield* child.exitCode;
    }).pipe(Effect.scoped, Effect.ignore),
  );
}

/** Serves the app on 127.0.0.1: client files directly, everything else through React Router. */
export function serve(options: ServeOptions) {
  const clientDirectory = resolve(options.clientDirectory);
  const handle = createRequestListener({ build: options.build, mode: "production" });
  const development = isTruthy(options.developmentBuildId)
    ? createDevelopmentBoundary({
        buildId: options.developmentBuildId,
        instanceId: options.runtimeInstanceId,
      })
    : null;

  const server = NodeHttpServer.createServer((request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      response
        .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
        .end("forbidden host");
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (development !== null) {
      const presented = request.headers[developmentBuildHeader];
      const decision = developmentRequestDecision(
        development,
        request.method,
        pathname,
        Array.isArray(presented) ? presented[0] : presented,
      );
      if (decision.kind !== "allow") {
        if (decision.kind === "reject")
          // Native stdout/stderr or SDK logging boundary preserves the existing output format.
          Effect.runSync(
            Console.warn(
              `[dev-backend] blocked ${request.method ?? "UNKNOWN"} ${pathname}: ${decision.error} ` +
                `(backend=${decision.backendBuildId}, browser=${decision.presentedBuildId ?? "missing"})`,
            ),
          );
        response
          .writeHead(decision.status, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(decision.body);
        return;
      }
    }
    const task = assetRuntime.runFork(
      Effect.gen(function* () {
        const file =
          request.method === "GET" || request.method === "HEAD"
            ? yield* clientFile(clientDirectory, pathname)
            : null;
        if (file === null)
          return yield* Effect.tryPromise({
            try: () => Promise.resolve(handle(request, response)),
            catch: (cause) => new Cause.UnknownError(cause),
          });
        response.writeHead(200, {
          "content-type": contentType(file),
          "cache-control": pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
          "x-content-type-options": "nosniff",
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        yield* fs.stream(file).pipe(
          Stream.run(
            NodeSink.fromWritable({
              evaluate: () => response,
              onError: (cause) => new Cause.UnknownError(cause),
            }),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            response.destroy(new Error(Cause.pretty(cause)));
          }),
        ),
      ),
    );
    response.once("close", () => {
      void Effect.runFork(Fiber.interrupt(task));
    });
  });

  if (development !== null) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(signal, () => {
        development.beginDrain();
        server.close();
      });
  }

  // Node owns the listening server; the startup callback subscription ends with the handshake.
  return runNativeEffect(
    Effect.callback<void, Cause.UnknownError>((resume) => {
      const onError = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
      server.once("error", onError);
      server.listen(options.port, "127.0.0.1", () => resume(Effect.void));
      return Effect.sync(() => server.off("error", onError));
    }),
  );
}
