import { it } from "@effect/vitest";
import { Cause, Effect, Layer, Ref } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Embedder, EmbeddingError } from "../src/memory/embedding/embedder.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { VectorIndex } from "../src/memory/embedding/vector-index.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { testRuntime } from "./support/runtime.ts";

it.live(
  "revalidates late embedding once per batch and preserves vector positions for unchanged nodes",
  () =>
    Effect.gen(function* () {
      const hook = yield* Ref.make<Effect.Effect<void, EmbeddingError>>(Effect.void);
      const identity = "late-publication-fixture";
      const embedder = Layer.succeed(Embedder, {
        identity,
        dimensions: 384,
        runtime: () => ({ kind: "other" }),
        embed: Effect.fnUntraced(function* (texts: readonly string[]) {
          yield* yield* Ref.get(hook);
          return texts.map(fakeVector);
        }),
      });
      const { runtime, project, session } = yield* Effect.tryPromise({
        try: () => testRuntime({ embedder }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const services = yield* runtime.contextEffect;
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const nodes = yield* Nodes;
          const append = (text: string) =>
            nodes.append({ projectId: project.id, sessionId: session.id, kind: "user", text });
          const stable = append("unchanged SQLite statement");
          const changed = append("old text before embedding");
          const emptied = append("text emptied during embedding");
          const suppressed = append("suppressed during embedding");
          const recorded = append("recorded elsewhere during embedding");
          const { sqlite, atomic } = yield* Database;
          const index = yield* VectorIndex;
          yield* Ref.set(
            hook,
            Effect.gen(function* () {
              // Same index owner, saved before recording: no fake mapping without a vector.
              yield* index
                .add([recorded.seq], [fakeVector(recorded.text)])
                .pipe(Effect.mapError((cause) => new EmbeddingError({ cause })));
              yield* index.save.pipe(Effect.mapError((cause) => new EmbeddingError({ cause })));
              yield* Effect.try({
                try: () =>
                  atomic(() => {
                    // Use the existing permitted text-redaction path; do not disable immutable evidence triggers.
                    sqlite.prepare("INSERT INTO secret_sweep_permits VALUES (?)").run(changed.seq);
                    sqlite
                      .prepare("UPDATE nodes SET text=? WHERE seq=?")
                      .run("new current text", changed.seq);
                    sqlite
                      .prepare("DELETE FROM secret_sweep_permits WHERE node_seq=?")
                      .run(changed.seq);
                    // Preserve referenced evidence/FKs; use permitted redaction to make it no longer meaningful.
                    sqlite.prepare("INSERT INTO secret_sweep_permits VALUES (?)").run(emptied.seq);
                    sqlite.prepare("UPDATE nodes SET text=? WHERE seq=?").run(" \t\n", emptied.seq);
                    sqlite
                      .prepare("DELETE FROM secret_sweep_permits WHERE node_seq=?")
                      .run(emptied.seq);
                    sqlite
                      .prepare(
                        "INSERT INTO memory_graph_suppressed_nodes(node_seq,version,reason) VALUES(?,1,'fixture')",
                      )
                      .run(suppressed.seq);
                    sqlite
                      .prepare("INSERT INTO node_vectors VALUES(?,?)")
                      .run(recorded.seq, identity);
                  }),
                catch: (cause) => new EmbeddingError({ cause }),
              });
            }),
          );
          const indexer = yield* Indexer;
          expect(yield* indexer.indexBatch(16)).toBe(1);
          expect(index.size()).toBe(2);
          expect(yield* index.search(fakeVector(stable.text), 1)).toMatchObject([
            { seq: stable.seq },
          ]);
          expect(
            sqlite
              .prepare("SELECT node_seq FROM node_vectors WHERE embedder=? ORDER BY node_seq")
              .all(identity),
          ).toEqual([{ node_seq: stable.seq }, { node_seq: recorded.seq }]);
          expect(sqlite.prepare("SELECT node_seq FROM secret_sweep_permits").all()).toEqual([]);
          yield* Ref.set(hook, Effect.void);
          expect(yield* indexer.indexBatch(16)).toBe(1);
          expect(index.size()).toBe(3);
          expect(yield* index.search(fakeVector("new current text"), 1)).toMatchObject([
            { seq: changed.seq },
          ]);
          expect(yield* indexer.pending).toBe(0);
        }),
        services,
      );
    }),
);
