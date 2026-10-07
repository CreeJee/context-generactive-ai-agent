import { it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Crypto, Deferred, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
// Real Vite watchers and module caches are owned by the test Scope.
import { expect } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite";

it.live(
  "SSR HMR replaces a module but leaves its old global owner alive",
  () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const join = paths.join;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-vite-hmr-" });
        let server: ViteDevServer;
        const moduleFile = join(root, "entry.ts");
        const hookEvents: string[] = [];
        const ownerKey = `__context_agent_hmr_test_${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
        const encodedOwnerKey = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
          ownerKey,
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Reflect.deleteProperty(globalThis, ownerKey);
          }),
        );
        const source = (revision: number) =>
          `export const revision = ${revision};\nexport const owner = (globalThis[${encodedOwnerKey}] ??= {revision});\n`;
        yield* fs.writeFileString(moduleFile, source(1));
        server = yield* Effect.acquireRelease(
          sdkCall(() =>
            createServer({
              configFile: false,
              root,
              appType: "custom",
              server: { middlewareMode: true },
              plugins: [
                {
                  name: "probe-ssr-hmr",
                  hotUpdate: ({ file }) => {
                    hookEvents.push(file);
                  },
                },
              ],
            }),
          ),
          (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
        );
        const first = yield* loadModule(server, "/entry.ts");
        expect(first.revision).toBe(1);
        yield* fs.writeFileString(moduleFile, source(2));
        const activeServer = server;
        yield* loadModule(activeServer, "/entry.ts").pipe(
          Effect.repeat({
            until: (module) => module.revision === 2,
            schedule: Schedule.spaced(20),
          }),
          Effect.timeout(8000),
        );
        const next = yield* loadModule(server, "/entry.ts");
        expect(first.revision).toBe(1);
        expect(next.owner).toBe(first.owner);
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Int }))(next.owner))
            .revision,
        ).toBe(1);
        expect(
          hookEvents.some((file) => file.endsWith("/entry.ts")),
          hookEvents.join(","),
        ).toBe(true);
      }),
    ),
  12_000,
);

it.live(
  "pending hotUpdate does not prevent concurrent SSR import of changed code",
  () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const join = paths.join;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-vite-drain-" });
        let server: ViteDevServer;
        const moduleFile = join(root, "entry.ts");
        yield* fs.writeFileString(moduleFile, "export const revision = 1;\n");
        const hookEntered = yield* Deferred.make<void>();
        const pendingHook = yield* Deferred.make<void>();
        const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
        server = yield* Effect.acquireRelease(
          sdkCall(() =>
            createServer({
              configFile: false,
              root,
              appType: "custom",
              server: { middlewareMode: true },
              plugins: [
                {
                  name: "probe-ssr-drain",
                  hotUpdate: ({ file }) =>
                    runNative(
                      Effect.gen(function* () {
                        if (file.endsWith("/entry.ts")) {
                          yield* Deferred.succeed(hookEntered, undefined);
                          yield* Deferred.await(pendingHook);
                        }
                      }),
                    ),
                },
              ],
            }),
          ),
          (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
        );
        yield* Effect.addFinalizer(() => Deferred.succeed(pendingHook, undefined));
        try {
          expect((yield* loadModule(server, "/entry.ts")).revision).toBe(1);
          yield* fs.writeFileString(moduleFile, "export const revision = 2;\n");
          yield* Deferred.await(hookEntered).pipe(Effect.timeout(8000));
          // Actual Vite invalidates before the pending hook resolves; no proposed owner gate is needed.
          expect((yield* loadModule(server, "/entry.ts")).revision).toBe(2);
        } finally {
          yield* Deferred.succeed(pendingHook, undefined);
        }
      }),
    ),
  12_000,
);

it.live(
  "watch.ignored alone does not isolate SSR modules from changed source",
  () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const join = paths.join;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-vite-isolated-" });
        let server: ViteDevServer;
        const moduleFile = join(root, "entry.ts");
        yield* fs.writeFileString(moduleFile, "export const revision = 1;\n");
        const config = {
          configFile: false as const,
          root,
          appType: "custom" as const,
          server: { middlewareMode: true as const, watch: { ignored: [moduleFile] } },
        };
        server = yield* Effect.acquireRelease(
          sdkCall(() => createServer(config)),
          (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
        );
        expect((yield* loadModule(server, "/entry.ts")).revision).toBe(1);
        yield* fs.writeFileString(moduleFile, "export const revision = 2;\n");
        // Vite's SSR module graph still invalidates despite Chokidar's ignored option.
        const activeServer = server;
        yield* loadModule(activeServer, "/entry.ts").pipe(
          Effect.repeat({
            until: (module) => module.revision === 2,
            schedule: Schedule.spaced(20),
          }),
          Effect.timeout(8000),
        );
      }),
    ),
  12_000,
);

it.live(
  "closing a Vite watcher keeps cached SSR code but does not freeze lazy imports",
  () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const join = paths.join;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-vite-frozen-" });
        let server: ViteDevServer;
        const moduleFile = join(root, "entry.ts");
        const lazyFile = join(root, "lazy.ts");
        yield* fs.writeFileString(moduleFile, "export const revision = 1;\n");
        yield* fs.writeFileString(lazyFile, "export const revision = 1;\n");
        const config = {
          configFile: false as const,
          root,
          appType: "custom" as const,
          server: { middlewareMode: true as const },
        };
        server = yield* Effect.acquireRelease(
          sdkCall(() => createServer(config)),
          (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
        );
        expect((yield* loadModule(server, "/entry.ts")).revision).toBe(1);
        yield* sdkCall(() => server.watcher.close());
        yield* fs.writeFileString(moduleFile, "export const revision = 2;\n");
        yield* fs.writeFileString(lazyFile, "export const revision = 2;\n");
        yield* Effect.sleep(300);
        expect((yield* loadModule(server, "/entry.ts")).revision).toBe(1);
        // No watcher can invalidate a module that the old worker has never imported.
        // It reads current source on its first import, even while its old owner is alive.
        expect((yield* loadModule(server, "/lazy.ts")).revision).toBe(2);
        yield* sdkCall(() => server.close());
        server = yield* Effect.acquireRelease(
          sdkCall(() => createServer(config)),
          (server) => sdkCall(() => server.close()).pipe(Effect.orDie),
        );
        expect((yield* loadModule(server, "/entry.ts")).revision).toBe(2);
      }),
    ),
  12_000,
);

const sdkCall = Effect.fn("ViteLifecycleTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const withPlatform = Effect.fn("ViteLifecycleTest.platform")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(
    Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer),
  );
  return yield* Effect.provideContext(program, services);
});
const loadModule = Effect.fn("ViteLifecycleTest.loadModule")(function* (
  server: ViteDevServer,
  path: string,
) {
  const result: unknown = yield* sdkCall(() => server.ssrLoadModule(path));
  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({ revision: Schema.Int, owner: Schema.optional(Schema.Unknown) }),
  )(result);
});
