import { NodeHttpPlatform, NodeHttpServer } from "@effect/platform-node";
import { path } from "memory-agent/synchronous-path";
import { runNativeEffect } from "memory-agent/native-effect";
import { nodePlatform, nodePlatformLayer } from "memory-agent/node-platform";
import { isTruthy } from "../app/truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import {
  Cause,
  Console,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Scope,
} from "effect";
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createRequestHandler, type ServerBuild } from "react-router";
import {
  developmentBuildHeader,
  developmentRequestDecision,
  createDevelopmentBoundary,
} from "./dev-safety.ts";

const { extname, resolve, sep } = path;

/**
 * Who can reach the server. `loopback` listens on 127.0.0.1 and answers only loopback Host names (R14).
 * `broadcast` listens on every interface and answers any Host, because the network can already reach it.
 */
export type Exposure = { readonly kind: "loopback" } | { readonly kind: "broadcast" };

export interface ServeOptions {
  readonly build: ServerBuild;
  readonly port: number;
  readonly exposure: Exposure;
  /** React Router's client build (`build/client`). */
  readonly clientDirectory: string;
  /** Present only for the stable development backend behind the HMR frontend. */
  readonly developmentBuildId?: string;
  readonly runtimeInstanceId: string;
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

/** What answering a request needs: the client build's files and Node's compression. */
const answerRuntime = ManagedRuntime.make(Layer.merge(nodePlatformLayer, NodeHttpPlatform.layer));

/**
 * Answers a request the host and development checks let through: a file of the client build, or
 * React Router.
 */
export const answer = Effect.fnUntraced(function* (
  clientDirectory: string,
  handle: ReturnType<typeof createRequestHandler>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file =
    request.method === "GET" || request.method === "HEAD"
      ? yield* clientFile(clientDirectory, pathname)
      : null;
  if (file !== null)
    return yield* HttpServerResponse.file(file, {
      headers: {
        "content-type": contentType(file),
        "cache-control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  // The request scope closes once the response is sent or the client goes away, so a streamed
  // answer (SSE) keeps its request alive until then.
  const signal = yield* Effect.abortSignal;
  const routed = yield* HttpServerRequest.toWeb(request, { signal });
  const response = yield* Effect.tryPromise({
    try: () => handle(routed),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  return HttpServerResponse.fromWeb(response);
});

export function openInBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  void nodePlatform.runPromise(
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

function listenFor(exposure: Exposure) {
  switch (exposure.kind) {
    case "loopback":
      return { address: "127.0.0.1", acceptsHost: isLoopbackHost };
    case "broadcast":
      return { address: "0.0.0.0", acceptsHost: () => true };
  }
}

/**
 * Serves the app per its exposure: client files directly, everything else through React Router.
 * Answers are compressed as the browser accepts (`br`, then `gzip`).
 */
export function serve(options: ServeOptions) {
  const listen = listenFor(options.exposure);
  const handle = answerRuntime.runSync(
    NodeHttpServer.makeHandler(
      answer(resolve(options.clientDirectory), createRequestHandler(options.build, "production")),
      // Request fibers live as long as the server.
      { scope: Scope.makeUnsafe(), middleware: HttpMiddleware.compression() },
    ),
  );
  const development = isTruthy(options.developmentBuildId)
    ? createDevelopmentBoundary({
        buildId: options.developmentBuildId,
        instanceId: options.runtimeInstanceId,
      })
    : null;

  const server = NodeHttpServer.createServer((request, response) => {
    if (!listen.acceptsHost(request.headers.host)) {
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
          nodePlatform.runFork(
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
    handle(request, response);
  });

  if (development !== null) {
    (["SIGINT", "SIGTERM", "SIGHUP"] as const).forEach((signal) =>
      process.once(signal, () => {
        development.beginDrain();
        server.close();
      }),
    );
  }

  // Node owns the listening server; the startup callback subscription ends with the handshake.
  return runNativeEffect(
    Effect.callback<void, Cause.UnknownError>((resume) => {
      const onError = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
      server.once("error", onError);
      server.listen(options.port, listen.address, () => resume(Effect.void));
      return Effect.sync(() => server.off("error", onError));
    }),
  );
}
