import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { createServer } from "vite-plus";
import { expect } from "vite-plus/test";

const sdkCall = Effect.fn("RuntimeResourcesDev.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

it.live(
  "development package exports load the real app and render its session page",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));
      return yield* Effect.provideContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
          const storage = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-export-ssr-" });
          const encodedStorage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
            storage,
          );
          const probe = path.join(root, "server", ".runtime-export-probe.ts");
          yield* fs.writeFileString(
            probe,
            `
import * as build from "virtual:react-router/server-build";
import { createRequestHandler } from "react-router";
import { runtimeRoot, runtimeWorkerOptions } from "memory-agent/runtime-resources";
build.entry.module.configureAgentBackend({ storageRoot: ${encodedStorage}, runtimeRoot: null });
const exportResult = { status: 0, html: "", root: null, workerRoot: null, marker: "" };
try {
  const response = await createRequestHandler(build, "development")(
    new Request("http://localhost/?project=72c2d6e0-23af-402d-be08-f74b28aee6e9&session=3bfb5fe9-4ef1-48be-be32-6f019e35b4a2")
  );
  exportResult.status = response.status;
  exportResult.html = await response.text();
  exportResult.root = runtimeRoot();
  exportResult.workerRoot = runtimeWorkerOptions({ marker: "kept" }).workerData.contextAgentRuntime.root;
  exportResult.marker = runtimeWorkerOptions({ marker: "kept" }).workerData.marker;
} finally { await build.entry.module.disposeAgent(); }
export const result = exportResult;
`,
          );
          yield* Effect.addFinalizer(() => fs.remove(probe, { force: true }).pipe(Effect.orDie));
          const server = yield* Effect.acquireRelease(
            sdkCall(() =>
              createServer({
                root,
                configFile: path.join(root, "vite.config.ts"),
                server: { middlewareMode: true, hmr: false, watch: null },
              }),
            ),
            (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
          );
          const loaded: unknown = yield* sdkCall(() =>
            server.ssrLoadModule("/server/.runtime-export-probe.ts"),
          );
          const { result } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              result: Schema.Struct({
                status: Schema.Int,
                html: Schema.String,
                root: Schema.Null,
                workerRoot: Schema.Null,
                marker: Schema.Literal("kept"),
              }),
            }),
          )(loaded);
          expect(result.status).toBe(200);
          expect(result.html).toContain("<!DOCTYPE html>");
          expect(result.html).toContain("<html");
          expect(yield* fs.readDirectory(storage)).toEqual([]);
        }),
        services,
      );
    }),
  60_000,
);
