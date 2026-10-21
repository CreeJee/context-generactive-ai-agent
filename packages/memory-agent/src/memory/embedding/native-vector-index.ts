// Native transport/filesystem/SQLite boundaries; the worker is the sole index and lease owner.
import { randomUUID, sha256 } from "../../runtime/synchronous-crypto.ts";
import { Array as EffectArray, Effect, Path, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { StorageRoot } from "../../config/storage-root.ts";
import { runtimeWorker } from "../../runtime/resources.ts";
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Backend composition root acquires its sole owner in the caller Scope.
import { makeNativeOwner } from "../native-search/client.ts";
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This owner-specific gate must be created alongside, not independently from, its worker.
import { makePublication } from "../native-search/publication.ts";
import type { NativeReadInput } from "../native-search/read-protocol.ts";
import { NativeOwnerFailed, OwnerCommand, OwnerReply } from "../native-search/worker-protocol.ts";
import { chunkVectorIdFloor } from "./chunks.ts";
import { Embedder } from "./embedder.ts";
import { VectorIndexError, type VectorHit, type VectorIndexApi } from "./vector-index.ts";

const Seq = Schema.Struct({ seq: Schema.Finite });
/** SQLite binds at most 32,766 variables per statement; id lists are split well below that. */
const idsPerStatement = 1000;

/** The sole application vector backend, acquired inside the application's Scope. */
export const makeNativeVectorIndex = Effect.gen(function* () {
  const paths = yield* Path.Path;
  const storage = yield* StorageRoot;
  const sql = yield* SqlClient.SqlClient;
  const embedder = yield* Embedder;
  const failure = (operation: VectorIndexError["operation"]) => (cause: unknown) =>
    VectorIndexError.make({ operation, cause });
  const io = <A>(operation: VectorIndexError["operation"], work: () => A) =>
    Effect.try({ try: work, catch: failure(operation) });
  /** Decodes a `SELECT … AS seq` result at this SQLite boundary. */
  const seqsOf = (rows: Effect.Effect<ReadonlyArray<object>, SqlError.SqlError>) =>
    rows.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Seq))),
      Effect.map((found) => found.map(({ seq }) => seq)),
    );
  /** Runs `query` over `ids` in bounded statements, in order, inside the caller's transaction. */
  const inBatches = <A, E>(
    ids: readonly number[],
    query: (batch: readonly number[]) => Effect.Effect<readonly A[], E>,
  ) =>
    Effect.forEach(EffectArray.chunksOf(ids, idsPerStatement), query).pipe(
      Effect.map((batches) => batches.flat()),
    );
  const databasePath = yield* sql`PRAGMA database_list`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ file: Schema.String }))),
    ),
    Effect.map((rows) => rows[0]?.file ?? ""),
    Effect.mapError(failure("open")),
  );
  const opened = yield* io("open", () => ({
    epoch: randomUUID(),
    worker: runtimeWorker("native-search-worker"),
    databasePath,
  }));
  if (opened.databasePath.length === 0)
    return yield* VectorIndexError.make({
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
  ).pipe(Effect.mapError(failure("open")));
  const command = (input: OwnerCommand, operation: VectorIndexError["operation"]) =>
    owner.execute(input).pipe(Effect.mapError(failure(operation)));
  const identity = () => ({ epoch: owner.epoch, requestId: randomUUID() });
  const save = Effect.suspend(() => command(OwnerCommand.cases.save.make(identity()), "save")).pipe(
    Effect.asVoid,
  );
  const ChunkMapping = Schema.Array(
    Schema.Struct({ vector_id: Schema.Finite, node_seq: Schema.Finite }),
  );
  /** Chunk mappings of these nodes (`node_seq IN …`) or of these chunk ids (`vector_id IN …`). */
  const mappings = (column: "node_seq" | "vector_id", ids: readonly number[]) =>
    inBatches(ids, (batch) =>
      sql`SELECT vector_id, node_seq FROM node_vector_chunks
        WHERE embedder = ${embedder.identity} AND ${sql(column)} IN ${sql.in(batch)}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ChunkMapping)),
      ),
    );
  const chunksOfNodes = (seqs: readonly number[]) => mappings("node_seq", seqs);
  const deleteChunks = (vectorIds: readonly number[]) =>
    inBatches(
      vectorIds,
      (batch) => sql`DELETE FROM node_vector_chunks WHERE vector_id IN ${sql.in(batch)}`,
    );
  const ackChunkRemovals = (vectorIds: readonly number[]) =>
    inBatches(
      vectorIds,
      (batch) =>
        sql`DELETE FROM memory_chunk_vector_removals
        WHERE embedder = ${embedder.identity} AND vector_id IN ${sql.in(batch)}`,
    );

  /**
   * Native ids to distinct nodes, best rank first, from one mapping read. A chunk id whose mapping
   * a purge or redaction deleted after the native search is dropped: it is not a node seq.
   */
  const nodeHits = (ids: readonly string[], scores: readonly number[]) =>
    Effect.gen(function* () {
      const chunkIds = ids.map(Number).filter((id) => id >= chunkVectorIdFloor);
      const parents = yield* mappings("vector_id", chunkIds);
      const parentOf = new Map(parents.map((row) => [row.vector_id, row.node_seq]));
      const seen = new Set<number>();
      return ids.flatMap((id, rank): VectorHit[] => {
        const native = Number(id);
        const seq = native < chunkVectorIdFloor ? native : parentOf.get(native);
        if (seq === undefined || seen.has(seq)) return [];
        seen.add(seq);
        return [{ seq, score: scores[rank]! }];
      });
    });

  // The owner runs one command at a time, so per-id commands only add round trips and let other
  // commands interleave between them. Like add, a batch is a single owner step.
  const removeIds = (ids: readonly number[]) =>
    ids.length === 0
      ? Effect.void
      : Effect.suspend(() =>
          command(
            OwnerCommand.cases.remove.make({ ...identity(), ids: ids.map(String) }),
            "remove",
          ),
        ).pipe(Effect.asVoid);
  const remove = Effect.fnUntraced(function* (seqs: readonly number[]) {
    // Read every node's chunk ids in one transaction before the native await, not one node
    // per await: a purge between reads would otherwise leave a partial snapshot.
    const chunkIds = yield* sql.withTransaction(chunksOfNodes(seqs)).pipe(
      Effect.map((chunks) => chunks.map((chunk) => chunk.vector_id)),
      Effect.mapError(failure("remove")),
    );
    yield* removeIds([...seqs, ...chunkIds]);
  });
  const flush = Effect.gen(function* () {
    // Snapshot both journals and live mappings in one transaction. Other agents can invalidate
    // nodes while native remove/save awaits; acknowledge only these exact IDs.
    const [pending, removedChunks] = yield* sql
      .withTransaction(
        Effect.all([
          seqsOf(sql`SELECT node_seq AS seq FROM memory_graph_vector_removals
            WHERE embedder = ${embedder.identity} ORDER BY node_seq`),
          seqsOf(sql`
            SELECT vector_id AS seq FROM memory_chunk_vector_removals
            WHERE embedder = ${embedder.identity}
            UNION SELECT c.vector_id AS seq FROM node_vector_chunks c
            JOIN memory_graph_vector_removals r ON r.node_seq = c.node_seq AND r.embedder = c.embedder
            WHERE c.embedder = ${embedder.identity}`),
        ]),
      )
      .pipe(Effect.mapError(failure("remove")));
    if (pending.length === 0 && removedChunks.length === 0) return;
    yield* removeIds([...removedChunks, ...pending]);
    yield* save;
    yield* sql
      .withTransaction(
        Effect.all([
          inBatches(
            pending,
            (batch) =>
              sql`DELETE FROM node_vectors
              WHERE embedder = ${embedder.identity} AND node_seq IN ${sql.in(batch)}`,
          ),
          inBatches(
            pending,
            (batch) =>
              sql`DELETE FROM memory_graph_vector_removals
              WHERE embedder = ${embedder.identity} AND node_seq IN ${sql.in(batch)}`,
          ),
          ackChunkRemovals(removedChunks),
        ]),
      )
      .pipe(Effect.mapError(failure("remove")));
  });
  if (!owner.initialNeedsReset) yield* flush;
  const reserved = yield* seqsOf(sql`
    SELECT c.vector_id AS seq FROM node_vector_chunks c
    LEFT JOIN node_vectors v ON v.node_seq = c.node_seq AND v.embedder = c.embedder
    WHERE c.embedder = ${embedder.identity} AND v.node_seq IS NULL`).pipe(
    Effect.mapError(failure("open")),
  );
  if (reserved.length > 0) {
    if (!owner.initialNeedsReset) {
      yield* removeIds(reserved);
      yield* save;
    }
    // Deleting a mapping journals its id for removal. These ids are already gone natively (or
    // the reset below drops everything), so the journal entry is acknowledged in the same step.
    yield* sql
      .withTransaction(Effect.all([deleteChunks(reserved), ackChunkRemovals(reserved)]))
      .pipe(Effect.mapError(failure("open")));
  }
  const indexed = yield* sql`SELECT count(*) AS count FROM node_vectors v
    LEFT JOIN node_vector_chunks c ON c.node_seq = v.node_seq AND c.embedder = v.embedder
    WHERE v.embedder = ${embedder.identity}`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ count: Schema.Finite })])),
    ),
    Effect.map(([{ count }]) => count),
    Effect.mapError(failure("open")),
  );
  if (!owner.initialNeedsReset && owner.size() > indexed) {
    const unrecorded = yield* seqsOf(sql`SELECT n.seq FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${embedder.identity}
      WHERE v.node_seq IS NULL`).pipe(Effect.mapError(failure("open")));
    yield* remove(unrecorded);
    if (owner.size() === indexed) yield* save;
  }
  if (owner.initialNeedsReset || owner.size() !== indexed) {
    yield* command(OwnerCommand.cases.reset.make(identity()), "open");
    yield* sql
      .withTransaction(
        Effect.all([
          sql`DELETE FROM node_vectors WHERE embedder = ${embedder.identity}`,
          sql`DELETE FROM memory_graph_vector_removals WHERE embedder = ${embedder.identity}`,
          sql`DELETE FROM memory_chunk_vector_removals WHERE embedder = ${embedder.identity}`,
        ]),
      )
      .pipe(Effect.mapError(failure("open")));
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
      OwnerCommand.cases.add.make({
        ...identity(),
        vectors: new Float32Array(batch),
        ids: seqs.map(String),
      }),
      "add",
    );
  });
  const publicationError = (cause: unknown) =>
    VectorIndexError.make({ operation: "search", cause });
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
      // A node with chunks is allowed through its chunk ids; a one-vector node through its seq.
      const allowedIds =
        allowedSeqs === undefined
          ? undefined
          : yield* sql.withTransaction(chunksOfNodes(allowedSeqs)).pipe(
              Effect.map((chunks) => {
                const childrenOf = EffectArray.groupBy(chunks, (chunk) => String(chunk.node_seq));
                return allowedSeqs.flatMap(
                  (seq) =>
                    childrenOf[String(seq)]?.map((chunk) => String(chunk.vector_id)) ?? [
                      String(seq),
                    ],
                );
              }),
              Effect.mapError(failure("search")),
            );
      const maximum = allowedIds?.length ?? owner.size();
      // Chunks of one node collapse into one hit, so `take` native hits can be fewer than `k`
      // nodes. Each round's size depends on the previous round's result: rounds are sequential.
      const widen = (take: number): Effect.Effect<VectorHit[], VectorIndexError> =>
        Effect.gen(function* () {
          const reply = yield* command(
            OwnerCommand.cases["vector-search"].make({
              ...identity(),
              query: new Float32Array(query),
              k: take,
              allowedIds,
            }),
            "search",
          );
          if (!OwnerReply.guards["vector-hits"](reply)) return yield* publicationError(reply);
          const hits = yield* nodeHits(reply.ids, reply.scores).pipe(
            Effect.mapError(failure("search")),
          );
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
          .read(() =>
            owner.startRead(OwnerCommand.cases["memory-search"].make({ ...identity(), input })),
          )
          .pipe(Effect.mapError(publicationError));
        if (!OwnerReply.guards["memory-result"](result)) return yield* publicationError(result);
        return { publication: current, result: result.result };
      }),
    },
  };
  return api;
});
