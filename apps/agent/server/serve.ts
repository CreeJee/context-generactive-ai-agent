import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createRequestListener } from "@react-router/node";
import { Schema } from "effect";
import type { ServerBuild } from "react-router";
import {
  developmentBuildHeader,
  developmentRequestDecision,
  createDevelopmentBoundary,
} from "./dev-safety.ts";

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
  if (!host) return false;
  try {
    return Schema.is(LoopbackHost)(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** A file of the client build for this path, or null to let React Router answer. */
function clientFile(clientDirectory: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = resolve(clientDirectory, `.${decoded}`);
  if (!file.startsWith(clientDirectory + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function openInBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** Serves the app on 127.0.0.1: client files directly, everything else through React Router. */
export function serve(options: ServeOptions) {
  const clientDirectory = resolve(options.clientDirectory);
  const handle = createRequestListener({ build: options.build, mode: "production" });
  const development = options.developmentBuildId
    ? createDevelopmentBoundary(options.developmentBuildId, options.runtimeInstanceId)
    : null;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
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
          console.warn(
            `[dev-backend] blocked ${request.method ?? "UNKNOWN"} ${pathname}: ${decision.error} ` +
              `(backend=${decision.backendBuildId}, browser=${decision.presentedBuildId ?? "missing"})`,
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
    const file =
      request.method === "GET" || request.method === "HEAD"
        ? clientFile(clientDirectory, pathname)
        : null;
    if (!file) return handle(request, response);
    response.writeHead(200, {
      "content-type": contentType(file),
      // Hashed build assets never change under the same name.
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return void response.end();
    createReadStream(file).pipe(response);
  });

  if (development !== null) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(signal, () => {
        development.beginDrain();
        server.close();
      });
  }

  return new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolveListening());
  });
}
