import { it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { HttpMiddleware, HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
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
        const server = yield* Effect.provideContext(HttpServer.HttpServer, services);
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
        const address = server.address;
        if (NetAddress.isUnixPathAddress(address))
          return yield* Effect.die(new Error("HTTP fixture requires TCP"));
        const base = `http://127.0.0.1:${address.port}`;
        const brotli = { "accept-encoding": "br" };

        const file = yield* Effect.promise(() =>
          fetch(`${base}/assets/app.js`, { headers: brotli }),
        );
        expect(file.headers.get("content-encoding")).toBe("br");
        expect(yield* Effect.promise(() => file.text())).toBe(script);

        // Each event is flushed through the compressor, so it arrives while the stream stays open.
        const visit = yield* Scope.make();
        const signal = yield* Effect.abortSignal.pipe(Scope.provide(visit));
        const events = yield* Effect.promise(() =>
          fetch(`${base}/api/events`, { headers: brotli, signal }),
        );
        expect(events.headers.get("content-encoding")).toBe("br");
        const reader = events.body?.getReader();
        if (reader === undefined) return yield* Effect.die(new Error("The stream has no body"));
        const first = yield* Effect.promise(() => reader.read()).pipe(Effect.timeout("2 seconds"));
        expect(new TextDecoder().decode(first.value)).toBe(ready);
        yield* Scope.close(visit, Exit.void);
        yield* Effect.promise(() => left.promise).pipe(Effect.timeout("2 seconds"));
      }),
  );
});
