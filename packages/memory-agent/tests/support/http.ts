import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

/** The listener, handler fibers and active response streams share the test Scope. */
export const testHttpServer = Effect.fn("testHttpServer")(function* <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const services = yield* Layer.build(
    Layer.fresh(
      NodeHttpServer.layer(createServer, {
        port: 0,
        host: "127.0.0.1",
        gracefulShutdownTimeout: "100 millis",
      }),
    ),
  );
  const server = yield* Effect.provideContext(HttpServer.HttpServer, services);
  yield* Effect.provideContext(HttpServer.serveEffect(handler), services);
  switch (server.address._tag) {
    case "InetAddressV4":
    case "InetAddressV6":
      return { url: `http://127.0.0.1:${server.address.port}`, port: server.address.port };
    case "UnixPathAddress":
      return yield* Effect.die(new Error("HTTP test fixture requires TCP"));
  }
});

/** A real Effect client; callers keep status, typed body decoding and interruption in Effect. */
export const testHttpClient = Effect.fn("testHttpClient")(function* () {
  const services = yield* Layer.build(FetchHttpClient.layer);
  return yield* Effect.provideContext(HttpClient.HttpClient, services);
});

export { HttpServerRequest, HttpServerResponse };
