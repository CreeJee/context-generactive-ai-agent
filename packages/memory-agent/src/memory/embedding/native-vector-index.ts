// Native transport/filesystem/SQLite boundaries; the worker is the sole index and lease owner.
import { randomUUID, sha256 } from "../../runtime/synchronous-crypto.ts";
import { Effect, Path, Schema } from "effect";
import { StorageRoot } from "../../config/storage-root.ts";
import { Database } from "../../db/database.ts";
import { runtimeWorker } from "../../runtime/resources.ts";
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Backend composition root acquires its sole owner in the caller Scope.
import { makeNativeOwner } from "../native-search/client.ts";
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This owner-specific gate must be created alongside, not independently from, its worker.
import { makePublication } from "../native-search/publication.ts";
import type { NativeReadInput } from "../native-search/read-protocol.ts";
import { NativeOwnerFailed, type OwnerCommand } from "../native-search/worker-protocol.ts";
import { Embedder } from "./embedder.ts";
import { VectorIndexError, type VectorIndexApi } from "./vector-index.ts";

/** The sole application vector backend, acquired inside the application's Scope. */
export const makeNativeVectorIndex = Effect.gen(function* () {
  const paths = yield* Path.Path;
  const storage = yield* StorageRoot;
  const { sqlite, atomic } = yield* Database;
  const embedder = yield* Embedder;
  const io = <A>(operation: VectorIndexError["operation"], work: () => A) =>
    Effect.try({ try: work, catch: (cause) => new VectorIndexError({ operation, cause }) });
  const databasePath = yield* io("open", () => sqlite.prepare("PRAGMA database_list").get()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ file: Schema.String }))),
    Effect.map(({ file }) => file),
    Effect.mapError((cause) => new VectorIndexError({ operation: "open", cause })),
  );
  const opened = yield* io("open", () => ({
    epoch: randomUUID(),
    worker: runtimeWorker("native-search-worker"),
    databasePath,
  }));
  if (opened.databasePath.length === 0)
    return yield* new VectorIndexError({
      operation: "open",
      cause: NativeOwnerFailed.make({ reason: "native-incompatible" }),
    });
  const owner = yield* makeNativeOwner(
    {
      kind: "setup",
      epoch: opened.epoch,
      dimensions: embedder.dimensions,
      bits: 4,
      cacheDirectory: paths.join(storage.path, "vectors", sha256(embedder.identity).slice(0, 16)),
      databasePath: opened.databasePath,
      recover: true,
    },
    opened.worker,
  ).pipe(Effect.mapError((cause) => new VectorIndexError({ operation: "open", cause })));
  const command = (input: OwnerCommand, operation: VectorIndexError["operation"]) =>
    owner
      .execute(input)
      .pipe(Effect.mapError((cause) => new VectorIndexError({ operation, cause })));
  const identity = () => ({ epoch: owner.epoch, requestId: randomUUID() });
  const save = Effect.suspend(() => command({ kind: "save", ...identity() }, "save")).pipe(
    Effect.asVoid,
  );
  const remove = Effect.fnUntraced(function* (seqs: readonly number[]) {
    for (const seq of seqs)
      yield* command({ kind: "remove", ...identity(), id: String(seq) }, "remove");
  });
  const flush = Effect.gen(function* () {
    const pending = yield* io("remove", () =>
      sqlite
        .prepare(
          "SELECT node_seq AS seq FROM memory_graph_vector_removals WHERE embedder = ? ORDER BY node_seq",
        )
        .all(embedder.identity),
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Finite }))),
      ),
      Effect.mapError((cause) => new VectorIndexError({ operation: "remove", cause })),
    );
    if (pending.length === 0) return;
    yield* remove(pending.map(({ seq }) => seq));
    yield* save;
    yield* io("remove", () =>
      atomic(() => {
        for (const { seq } of pending) {
          sqlite
            .prepare("DELETE FROM node_vectors WHERE node_seq = ? AND embedder = ?")
            .run(seq, embedder.identity);
          sqlite
            .prepare("DELETE FROM memory_graph_vector_removals WHERE node_seq = ? AND embedder = ?")
            .run(seq, embedder.identity);
        }
      }),
    );
  });
  if (!owner.initialNeedsReset) yield* flush;
  const indexed = yield* io("open", () =>
    sqlite
      .prepare("SELECT count(*) AS count FROM node_vectors WHERE embedder = ?")
      .get(embedder.identity),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }))),
    Effect.map(({ count }) => count),
    Effect.mapError((cause) => new VectorIndexError({ operation: "open", cause })),
  );
  if (!owner.initialNeedsReset && owner.size() > indexed) {
    const unrecorded = yield* io("open", () =>
      sqlite
        .prepare(
          "SELECT n.seq FROM nodes n LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ? WHERE v.node_seq IS NULL",
        )
        .all(embedder.identity),
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Finite }))),
      ),
      Effect.mapError((cause) => new VectorIndexError({ operation: "open", cause })),
    );
    yield* remove(unrecorded.map(({ seq }) => seq));
    if (owner.size() === indexed) yield* save;
  }
  if (owner.initialNeedsReset || owner.size() !== indexed) {
    yield* command({ kind: "reset", ...identity() }, "open");
    yield* io("open", () =>
      atomic(() => {
        sqlite.prepare("DELETE FROM node_vectors WHERE embedder = ?").run(embedder.identity);
        sqlite
          .prepare("DELETE FROM memory_graph_vector_removals WHERE embedder = ?")
          .run(embedder.identity);
      }),
    );
  }
  const publication = yield* makePublication(owner.epoch);
  const add = Effect.fnUntraced(function* (
    seqs: readonly number[],
    vectors: readonly Float32Array[],
  ) {
    const batch = yield* io("add", () => {
      const result = new Float32Array(vectors.length * embedder.dimensions);
      vectors.forEach((vector, row) => result.set(vector, row * embedder.dimensions));
      return result;
    });
    yield* command(
      { kind: "add", ...identity(), vectors: new Float32Array(batch), ids: seqs.map(String) },
      "add",
    );
  });
  const publicationError = (cause: unknown) => new VectorIndexError({ operation: "search", cause });
  const api: VectorIndexApi = {
    size: () => owner.size(),
    flushRemovals: publication.withMutation(flush, publicationError),
    add,
    remove,
    save,
    publish: (prepare) =>
      publication.withMutation(
        Effect.gen(function* () {
          const { seqs, vectors, commit } = yield* prepare;
          if (seqs.length > 0) yield* add(seqs, vectors).pipe(Effect.andThen(save));
          return yield* commit;
        }),
        publicationError,
      ),
    search: Effect.fnUntraced(function* (
      query: Float32Array,
      k: number,
      allowedSeqs?: readonly number[],
    ) {
      if (owner.size() === 0) return [];
      const reply = yield* command(
        {
          kind: "vector-search",
          ...identity(),
          query: new Float32Array(query),
          k,
          allowedIds: allowedSeqs?.map(String),
        },
        "search",
      );
      if (reply.kind !== "vector-hits") return yield* publicationError(reply);
      return reply.ids.map((id, rank) => ({ seq: Number(id), score: reply.scores[rank]! }));
    }),
    backend: {
      kind: "native",
      read: Effect.fnUntraced(function* (input: NativeReadInput) {
        if (input.embedder !== embedder.identity)
          return yield* publicationError(NativeOwnerFailed.make({ reason: "invalid-input" }));
        const { publication: current, result } = yield* publication
          .read(() => owner.startRead({ kind: "memory-search", ...identity(), input }))
          .pipe(Effect.mapError(publicationError));
        switch (result.kind) {
          case "memory-result":
            return { publication: current, result: result.result };
          default:
            return yield* publicationError(result);
        }
      }),
    },
  };
  return api;
});
