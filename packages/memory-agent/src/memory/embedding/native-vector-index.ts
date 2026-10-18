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
import { chunkVectorIdFloor } from "./chunks.ts";
import { Embedder } from "./embedder.ts";
import { VectorIndexError, type VectorHit, type VectorIndexApi } from "./vector-index.ts";

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
  const decodeSeqs = Schema.decodeUnknownResult(
    Schema.Array(Schema.Struct({ seq: Schema.Finite })),
  );
  type Statement = ReturnType<typeof sqlite.prepare>;
  /** Runs a `SELECT … AS seq` statement and decodes its rows at this SQLite boundary. */
  const seqsOf = (statement: Statement, ...values: readonly (string | number)[]) =>
    Result.getOrThrow(decodeSeqs(statement.all(...values))).map(({ seq }) => seq);
  const chunkIdsOfNode = sqlite.prepare(
    "SELECT vector_id AS seq FROM node_vector_chunks WHERE node_seq=? AND embedder=?",
  );
  const nodeOfChunk = sqlite.prepare(
    "SELECT node_seq AS seq FROM node_vector_chunks WHERE vector_id=? AND embedder=?",
  );
  const journaledNodes = sqlite.prepare(
    "SELECT node_seq AS seq FROM memory_graph_vector_removals WHERE embedder=? ORDER BY node_seq",
  );
  const journaledChunks = sqlite.prepare(`
    SELECT vector_id AS seq FROM memory_chunk_vector_removals WHERE embedder=?
    UNION SELECT c.vector_id AS seq FROM node_vector_chunks c
    JOIN memory_graph_vector_removals r ON r.node_seq=c.node_seq AND r.embedder=c.embedder
    WHERE c.embedder=?`);
  const reservedChunks = sqlite.prepare(`
    SELECT c.vector_id AS seq FROM node_vector_chunks c
    LEFT JOIN node_vectors v ON v.node_seq=c.node_seq AND v.embedder=c.embedder
    WHERE c.embedder=? AND v.node_seq IS NULL`);
  const unmarkNode = sqlite.prepare("DELETE FROM node_vectors WHERE node_seq=? AND embedder=?");
  const ackNodeRemoval = sqlite.prepare(
    "DELETE FROM memory_graph_vector_removals WHERE node_seq=? AND embedder=?",
  );
  const ackChunkRemoval = sqlite.prepare(
    "DELETE FROM memory_chunk_vector_removals WHERE vector_id=? AND embedder=?",
  );
  const deleteChunk = sqlite.prepare("DELETE FROM node_vector_chunks WHERE vector_id=?");

  /**
   * Native ids to distinct nodes, best rank first. A chunk id whose mapping a purge or redaction
   * deleted after the native search is dropped: it is not a node seq.
   */
  const nodeHits = (ids: readonly string[], scores: readonly number[]): VectorHit[] => {
    const seen = new Set<number>();
    return ids.flatMap((id, rank) => {
      const [seq] =
        Number(id) < chunkVectorIdFloor ? [Number(id)] : seqsOf(nodeOfChunk, id, embedder.identity);
      if (seq === undefined || seen.has(seq)) return [];
      seen.add(seq);
      return [{ seq, score: scores[rank]! }];
    });
  };

  // The owner runs one command at a time, so per-id commands only add round trips and let other
  // commands interleave between them. Like add, a batch is a single owner step.
  const removeIds = (ids: readonly number[]) =>
    ids.length === 0
      ? Effect.void
      : Effect.suspend(() =>
          command({ kind: "remove", ...identity(), ids: ids.map(String) }, "remove"),
        ).pipe(Effect.asVoid);
  const remove = Effect.fnUntraced(function* (seqs: readonly number[]) {
    // Read every node's chunk ids in one transaction before the native await, not one node
    // per await: a purge between reads would otherwise leave a partial snapshot.
    const chunkIds = yield* io("remove", () =>
      atomic(() => seqs.flatMap((seq) => seqsOf(chunkIdsOfNode, seq, embedder.identity))),
    );
    yield* removeIds([...seqs, ...chunkIds]);
  });
  const flush = Effect.gen(function* () {
    // Snapshot both journals and live mappings in one transaction. Other agents can invalidate
    // nodes while native remove/save awaits; acknowledge only these exact IDs.
    const { pending, removedChunks } = yield* io("remove", () =>
      atomic(() => ({
        pending: seqsOf(journaledNodes, embedder.identity),
        removedChunks: seqsOf(journaledChunks, embedder.identity, embedder.identity),
      })),
    );
    if (pending.length === 0 && removedChunks.length === 0) return;
    yield* removeIds([...removedChunks, ...pending]);
    yield* save;
    yield* io("remove", () =>
      atomic(() => {
        for (const seq of pending) {
          unmarkNode.run(seq, embedder.identity);
          ackNodeRemoval.run(seq, embedder.identity);
        }
        for (const seq of removedChunks) ackChunkRemoval.run(seq, embedder.identity);
      }),
    );
  });
  if (!owner.initialNeedsReset) yield* flush;
  const reserved = yield* io("open", () => seqsOf(reservedChunks, embedder.identity));
  if (reserved.length > 0) {
    if (!owner.initialNeedsReset) {
      yield* removeIds(reserved);
      yield* save;
    }
    // Deleting a mapping journals its id for removal. These ids are already gone natively (or
    // the reset below drops everything), so the journal entry is acknowledged in the same step.
    yield* io("open", () =>
      atomic(() => {
        for (const seq of reserved) {
          deleteChunk.run(seq);
          ackChunkRemoval.run(seq, embedder.identity);
        }
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
              atomic(() =>
                allowedSeqs.flatMap((seq) => {
                  const chunks = seqsOf(chunkIdsOfNode, seq, embedder.identity);
                  return chunks.length === 0 ? [String(seq)] : chunks.map(String);
                }),
              ),
            );
      const maximum = allowedIds?.length ?? owner.size();
      // Chunks of one node collapse into one hit, so `take` native hits can be fewer than `k`
      // nodes. Each round's size depends on the previous round's result: rounds are sequential.
      const widen = (take: number): Effect.Effect<VectorHit[], VectorIndexError> =>
        Effect.gen(function* () {
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
          const hits = yield* io("search", () => nodeHits(reply.ids, reply.scores));
          return hits.length >= k || take === maximum || reply.ids.length < take
            ? hits.slice(0, k)
            : yield* widen(Math.min(take * 2, maximum));
        });
      const first = Math.min(k, maximum);
      return first > 0 ? yield* widen(first) : [];
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
