import { Effect, FileSystem, Layer, Logger, Path } from "effect";
import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { StorageRoot } from "../../src/config/storage-root.ts";
import { Database } from "../../src/db/database.ts";
import { EmbedderRuntime, Embedder } from "../../src/memory/embedding/embedder.ts";
import { nativeVectorIndexLayer } from "../../src/memory/embedding/native-vector-index.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";

/** The native vector index over a fresh storage root and database, for the test's Scope. */
const nativeIndex = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "native-vector-factory-" });
  const foundation = Layer.mergeAll(
    StorageRoot.layer(directory),
    Database.layer(path.join(directory, "memory.sqlite")),
    Layer.succeed(Embedder, {
      identity: "native-factory-fixture",
      dimensions: 384,
      runtime: () => EmbedderRuntime.other(),
      embed: () => Effect.succeed([]),
    }),
  );
  return yield* Layer.build(nativeVectorIndexLayer.pipe(Layer.provide(foundation)));
});

layer(NodeServices.layer)((it) => {
  it.effect(
    "uses the same VectorIndex service with sole native owner, cached size and admitted publication",
    () =>
      Effect.gen(function* () {
        const services = yield* nativeIndex;
        yield* Effect.provideContext(
          Effect.gen(function* () {
            const index = yield* VectorIndex;
            expect(index.size()).toBe(0);
            const vector = new Float32Array(384);
            vector[0] = 1;
            yield* index.publish(
              Effect.succeed({ seqs: [1], vectors: [vector], commit: Effect.void }),
            );
            expect(index.size()).toBe(1);
            const hits = yield* index.search(vector, 1);
            expect(hits[0]?.seq).toBe(1);
            expect(hits[0]?.score).toBeGreaterThan(0.99);
            yield* index.remove([1]);
            yield* index.save;
            expect(index.size()).toBe(0);
            const read = yield* index.backend.read({
              allowedProjects: [],
              embedder: "native-factory-fixture",
              trigramTerms: [],
              shortTerms: [],
              morphQuery: "",
              vectorK: 1,
              textK: 1,
              morphK: 1,
              textEnabled: false,
              morphEnabled: false,
              remainingMs: 2000,
              inputBudgetBytes: 1048576,
              outputBudgetBytes: 1048576,
              coverage: "none",
            });
            expect(read.publication.generation).toBe(1);
            expect(read.result.kind).toBe("success");
          }),
          services,
        );
      }),
  );

  it.effect("logs the update that stops the index once, with its operation and native reason", () =>
    Effect.gen(function* () {
      const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
      const capture = Logger.make((log) => {
        logs.push(Logger.formatStructured.log(log));
      });
      const services = yield* nativeIndex;
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const index = yield* VectorIndex;
          const vector = new Float32Array(384).fill(Number.NaN);
          const update = index.publish(
            Effect.succeed({ seqs: [1], vectors: [vector], commit: Effect.void }),
          );
          yield* Effect.flip(update);
          yield* Effect.flip(update);
          expect(logs.filter((log) => log.level === "WARN")).toEqual([
            {
              ...logs.find((log) => log.level === "WARN"),
              message: [
                "Vector index stopped after a failed update",
                {
                  error: "VectorIndexError",
                  cause: "NativeOwnerFailed",
                  operation: "add",
                  reason: "invalid-input",
                },
              ],
            },
          ]);
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([capture]))),
        services,
      );
    }),
  );
});
