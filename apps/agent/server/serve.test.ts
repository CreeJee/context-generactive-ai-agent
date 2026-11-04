import { it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, FileSystem, Layer, Option, Scope, Stream } from "effect";
import { HttpClient, HttpMiddleware, HttpServer } from "effect/http";
import { describe, expect } from "vite-plus/test";
import { answer } from "./serve";

const script = "export const answer = 42;\n".repeat(200);
const ready = "event: ready\ndata: {}\n\n";

describe("serving the app", () => {
  it.live(
    "compresses files and streamed answers with brotli, and lets a leaving client end the route",
    () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
        const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
        const client = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${client}/assets`);
        yield* fs.writeFileString(`${client}/assets/app.js`, script);

        // React Router's place: an event stream that stays open until the client leaves.
        const left = Promise.withResolvers<void>();
        const route = (request: Request) => {
          request.signal.addEventListener("abort", () => left.resolve());
          const body = new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(new TextEncoder().encode(ready)),
          });
          return Promise.resolve(
            new Response(body, { headers: { "content-type": "text/event-stream" } }),
          );
        };
        yield* Effect.provideContext(
          HttpServer.serveEffect(answer(client, route), HttpMiddleware.compression()),
          services,
        );
        const http = yield* Effect.provideContext(HttpClient.HttpClient, services);
        const brotli = { "accept-encoding": "br" };

        const file = yield* http.get("/assets/app.js", { headers: brotli });
        expect(file.headers["content-encoding"]).toBe("br");
        expect(yield* file.text).toBe(script);

        // Each event is flushed through the compressor, so it arrives while the stream stays open.
        const visit = yield* Scope.make();
        const events = yield* HttpClient.withScope(http)
          .get("/api/events", { headers: brotli })
          .pipe(Scope.provide(visit));
        expect(events.headers["content-encoding"]).toBe("br");
        const first = yield* Stream.runHead(events.stream).pipe(Effect.timeout("2 seconds"));
        expect(Option.map(first, (chunk) => new TextDecoder().decode(chunk))).toEqual(
          Option.some(ready),
        );
        yield* Scope.close(visit, Exit.void);
        yield* Effect.promise(() => left.promise).pipe(Effect.timeout("2 seconds"));
      }),
  );
});
