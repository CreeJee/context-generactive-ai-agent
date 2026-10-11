import { layer } from "@effect/vitest";
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { Hex } from "effect/encoding";
import { Cause, Effect, FileSystem, Path, Crypto, Layer } from "effect";
import { expect } from "vite-plus/test";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { IndexingError } from "../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../src/memory/embedding/vector-index.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { testRuntime } from "./support/runtime.ts";

layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect("native publication saves before host commit and preserves its typed failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const { runtime, project, session } = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const services = yield* runtime.contextEffect;
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const vectors = yield* VectorIndex;
          const nodes = yield* Nodes;
          const storage = yield* StorageRoot;
          const embedder = yield* Embedder;
          const { sqlite, atomic } = yield* Database;
          expect(vectors.backend.kind).toBe("native");
          const first = nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "first publication",
          });
          const file = path.join(
            storage.path,
            "vectors",
            Hex.encode(
              yield* crypto.digest("SHA-256", new TextEncoder().encode(embedder.identity)),
            ).slice(0, 16),
            "index.tvim",
          );
          yield* vectors.publish(
            Effect.succeed({
              seqs: [first.seq],
              vectors: [fakeVector(first.text)],
              commit: fs.exists(file).pipe(
                Effect.flatMap((exists) =>
                  Effect.try({
                    try: () => {
                      expect(exists).toBe(true);
                      atomic(() =>
                        sqlite
                          .prepare("INSERT INTO node_vectors VALUES (?,?)")
                          .run(first.seq, embedder.identity),
                      );
                    },
                    catch: () => IndexingError.make({ reason: "mapping-commit-failed" }),
                  }),
                ),
              ),
            }),
          );
          const second = nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "failed host commit",
          });
          const failure = yield* Effect.flip(
            vectors.publish(
              Effect.succeed({
                seqs: [second.seq],
                vectors: [fakeVector(second.text)],
                commit: Effect.fail(IndexingError.make({ reason: "mapping-commit-failed" })),
              }),
            ),
          );
          expect(failure).toMatchObject({ _tag: "IndexingError", reason: "mapping-commit-failed" });
          expect(vectors.size()).toBe(2); // Saved ahead-of-DB; existing reopen recovery repairs this, not a fake rollback.
          expect(
            sqlite
              .prepare("SELECT node_seq FROM node_vectors WHERE embedder=?")
              .all(embedder.identity),
          ).toEqual([{ node_seq: first.seq }]);
        }),
        services,
      );
    }),
  );
});
