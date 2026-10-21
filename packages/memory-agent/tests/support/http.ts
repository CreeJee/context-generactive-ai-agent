import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { NetAddress } from "effect/net";
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
  const services = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
  const server = yield* Effect.provideContext(HttpServer.HttpServer, services);
  yield* Effect.provideContext(HttpServer.serveEffect(handler), services);
  return yield* Effect.succeed(server.address).pipe(
    Effect.filterOrElse(NetAddress.isInetAddress, () =>
      Effect.die(new Error("HTTP test fixture requires TCP")),
    ),
    Effect.map(({ port }) => ({ url: `http://127.0.0.1:${port}`, port })),
  );
});

/** A real Effect client; callers keep status, typed body decoding and interruption in Effect. */
export const testHttpClient = Effect.fn("testHttpClient")(function* () {
  const services = yield* Layer.build(FetchHttpClient.layer);
  return yield* Effect.provideContext(HttpClient.HttpClient, services);
});

export { HttpServerRequest, HttpServerResponse };
