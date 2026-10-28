import { Hex } from "effect/encoding";
import { Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { EmbedderRuntime, Embedder } from "../src/memory/embedding/embedder.ts";
import { VectorIndex } from "../src/memory/embedding/vector-index.ts";
import { requireRuntime } from "../src/runtime/resources.ts";

layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect.each(["missing", "layout-mismatch", "unrecorded-ahead"] as const)(
    "native startup repairs %s without a second owner",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-vector-recovery-" });
        const identity = "native-recovery-fixture";
        const cache = path.join(
          directory,
          "vectors",
          Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(identity))).slice(
            0,
            16,
          ),
        );
        // Seed a saved-file fixture BEFORE the scoped owner exists; no host lease/index service.
        yield* Effect.when(
          Effect.gen(function* () {
            yield* fs.makeDirectory(cache, { recursive: true, mode: 0o700 });
            const { VectorIndex: FixtureIndex } = (yield* requireRuntime(
              "turbovec",
            )).loadTurbovec();
            const dimensions = kind === "layout-mismatch" ? 64 : 384;
            const saved = new FixtureIndex(dimensions, 4);
            const value = new Float32Array(dimensions);
            value[0] = 1;
            saved.add(value, ["999"]);
            saved.save(path.join(cache, "index.tvim"));
          }),
          Effect.succeed(kind !== "missing"),
        );
        const foundation = Layer.mergeAll(
          StorageRoot.layer(directory),
          Database.layer(path.join(directory, "memory.sqlite")),
          Layer.succeed(Embedder, {
            identity,
            dimensions: 384,
            runtime: () => EmbedderRuntime.other(),
            embed: () => Effect.succeed([]),
          }),
        );
        const services = yield* Layer.build(VectorIndex.layer.pipe(Layer.provide(foundation)));
        yield* Effect.provideContext(
          Effect.gen(function* () {
            const index = yield* VectorIndex;
            expect(index.backend.kind).toBe("native");
            expect(index.size()).toBe(0);
            const value = new Float32Array(384);
            value[0] = 1;
            yield* index.publish(
              Effect.succeed({ seqs: [1], vectors: [value], commit: Effect.void }),
            );
            expect(index.size()).toBe(1);
            expect((yield* index.search(value, 1))[0]?.seq).toBe(1);
          }),
          services,
        );
      }),
  );
});
