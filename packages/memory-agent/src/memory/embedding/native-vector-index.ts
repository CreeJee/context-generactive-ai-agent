// Native transport/filesystem/SQLite boundaries; the worker is the sole index and lease owner.
import { randomUUID, sha256 } from "../../runtime/synchronous-crypto.ts";
import { Effect, Path, Result, Schema } from "effect";
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
  const removeIds = Effect.fnUntraced(function* (seqs: readonly number[]) {
    for (const seq of seqs)
      yield* command({ kind: "remove", ...identity(), id: String(seq) }, "remove");
  });
  const readSeqs = (sql: string, values: readonly (string | number)[]) =>
    io("remove", () => sqlite.prepare(sql).all(...values)).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Finite }))),
      ),
      Effect.mapError((cause) => new VectorIndexError({ operation: "remove", cause })),
    );
  const remove = Effect.fnUntraced(function* (seqs: readonly number[]) {
    for (const seq of seqs) {
      const chunks = yield* readSeqs(
        "SELECT vector_id AS seq FROM node_vector_chunks WHERE node_seq=? AND embedder=?",
        [seq, embedder.identity],
      );
      yield* removeIds([seq, ...chunks.map((chunk) => chunk.seq)]);
    }
  });
  const flush = Effect.gen(function* () {
    const removedChunks = yield* readSeqs(
      "SELECT vector_id AS seq FROM memory_chunk_vector_removals WHERE embedder=?",
      [embedder.identity],
    );
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
    if (pending.length === 0 && removedChunks.length === 0) return;
    yield* removeIds(removedChunks.map(({ seq }) => seq));
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
        sqlite
          .prepare("DELETE FROM memory_chunk_vector_removals WHERE embedder=?")
          .run(embedder.identity);
      }),
    );
  });
  if (!owner.initialNeedsReset) yield* flush;
  const reserved = yield* readSeqs(
    `SELECT c.vector_id AS seq FROM node_vector_chunks c
     LEFT JOIN node_vectors v ON v.node_seq=c.node_seq AND v.embedder=c.embedder
     WHERE c.embedder=? AND v.node_seq IS NULL`,
    [embedder.identity],
  );
  if (reserved.length > 0) {
    if (!owner.initialNeedsReset) {
      yield* removeIds(reserved.map(({ seq }) => seq));
      yield* save;
    }
    yield* io("open", () =>
      atomic(() => {
        for (const { seq } of reserved)
          sqlite.prepare("DELETE FROM node_vector_chunks WHERE vector_id=?").run(seq);
      }),
    );
  }
  const indexed = yield* io("open", () =>
    sqlite
      .prepare(`SELECT count(*) AS count FROM node_vectors v LEFT JOIN node_vector_chunks c
        ON c.node_seq=v.node_seq AND c.embedder=v.embedder WHERE v.embedder = ?`)
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
        sqlite
          .prepare("DELETE FROM memory_chunk_vector_removals WHERE embedder=?")
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
      const allowedIds =
        allowedSeqs === undefined
          ? undefined
          : yield* io("search", () =>
              allowedSeqs.flatMap((seq) => {
                const chunks = sqlite
                  .prepare(
                    "SELECT vector_id AS seq FROM node_vector_chunks WHERE node_seq=? AND embedder=?",
                  )
                  .all(seq, embedder.identity);
                const decoded = Result.getOrThrow(
                  Schema.decodeUnknownResult(Schema.Array(Schema.Struct({ seq: Schema.Finite })))(
                    chunks,
                  ),
                );
                return decoded.length === 0
                  ? [String(seq)]
                  : decoded.map((chunk) => String(chunk.seq));
              }),
            );
      const maximum = allowedIds?.length ?? owner.size();
      let take = Math.min(k, maximum);
      while (take > 0) {
        const reply = yield* command(
          {
            kind: "vector-search",
            ...identity(),
            query: new Float32Array(query),
            k: take,
            allowedIds,
          },
          "search",
        );
        if (reply.kind !== "vector-hits") return yield* publicationError(reply);
        const hits = yield* io("search", () => {
          const seen = new Set<number>();
          return reply.ids.flatMap((id, rank) => {
            const mapped = sqlite
              .prepare(
                "SELECT node_seq AS seq FROM node_vector_chunks WHERE vector_id=? AND embedder=?",
              )
              .get(id, embedder.identity);
            const seq =
              mapped === undefined
                ? Number(id)
                : Result.getOrThrow(
                    Schema.decodeUnknownResult(Schema.Struct({ seq: Schema.Finite }))(mapped),
                  ).seq;
            if (seen.has(seq)) return [];
            seen.add(seq);
            return [{ seq, score: reply.scores[rank]! }];
          });
        });
        if (hits.length >= k || take === maximum || reply.ids.length < take)
          return hits.slice(0, k);
        take = Math.min(take * 2, maximum);
      }
      return [];
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
