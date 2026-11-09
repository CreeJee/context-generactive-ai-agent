// Native transport/filesystem/SQLite boundaries; the worker is the sole index and lease owner.
import { NodeCrypto, NodePath } from "@effect/platform-node";
import { sha256 } from "../../runtime/synchronous-crypto.ts";
import {
  Array as EffectArray,
  Effect,
  HashMap,
  Iterable,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, type SqlError } from "effect/sql";
import { StorageRoot } from "../../config/storage-root.ts";
import { runtimeWorker } from "../../runtime/resources.ts";
import { NativeOwner } from "../native-search/client.ts";
import { NativePublication } from "../native-search/publication.ts";
import type { NativeReadInput } from "../native-search/read-protocol.ts";
import {
  type LexicalDocument,
  NativeOwnerFailed,
  OwnerCommand,
  OwnerReply,
} from "../native-search/worker-protocol.ts";
import { chunkVectorIdFloor } from "./chunks.ts";
import { Embedder } from "./embedder.ts";
import {
  VectorIndex,
  VectorIndexError,
  type VectorHit,
  type VectorIndexApi,
} from "./vector-index.ts";

const Seq = Schema.Struct({ seq: Schema.Finite });
/**
 * What the lexical index holds and how it splits text: its schema, the trigram and Lindera
 * analysis. A different layout is a different folder, rebuilt from every node.
 */
export const lexicalLayout = "tantivy-0.27/ngram3+lindera-ko-dic-kiwi-rules/v1";
/** SQLite binds at most 32,766 variables per statement; id lists are split well below that. */
const idsPerStatement = 1000;

const failure = (operation: VectorIndexError["operation"]) => (cause: unknown) =>
  VectorIndexError.make({ operation, cause });

/**
 * The native owner of the active embedder's index: a worker reading the application's database
 * file, keeping vectors and the lexical index under the storage root.
 */
const nativeOwnerLayer = Layer.effectContext(
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    const storage = yield* StorageRoot;
    const sql = yield* SqlClient.SqlClient;
    const embedder = yield* Embedder;
    const crypto = yield* SecureRandom.SecureRandom;
    const databasePath = yield* sql`PRAGMA database_list`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ file: Schema.String }))),
      ),
      Effect.map((rows) => rows[0]?.file ?? ""),
      Effect.mapError(failure("open")),
    );
    const worker = yield* runtimeWorker("native-search-worker").pipe(
      Effect.mapError(failure("open")),
    );
    yield* Effect.when(
      Effect.fail(
        VectorIndexError.make({
          operation: "open",
          cause: NativeOwnerFailed.make({ reason: "native-incompatible" }),
        }),
      ),
      Effect.succeed(databasePath.length === 0),
    );
    const owner = NativeOwner.layer(
      {
        kind: "setup",
        epoch: yield* crypto.uuidV4(),
        dimensions: embedder.dimensions,
        bits: 4,
        cacheDirectory: paths.join(storage.path, "vectors", sha256(embedder.identity).slice(0, 16)),
        databasePath,
        lexicalDirectory: paths.join(storage.path, "lexical", sha256(lexicalLayout).slice(0, 16)),
        recover: true,
      },
      worker,
    );
    // Built here so a failed open is a VectorIndexError (`open`), which startup explains.
    return yield* Layer.build(owner).pipe(Effect.mapError(failure("open")));
  }),
);

const makeNativeVectorIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const embedder = yield* Embedder;
  const crypto = yield* SecureRandom.SecureRandom;
  const owner = yield* NativeOwner;
  const publication = yield* NativePublication;
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
    Effect.forEach(Iterable.chunksOf(ids, idsPerStatement), query).pipe(
      Effect.map((batches) => batches.flat()),
    );
  const command = (input: OwnerCommand, operation: VectorIndexError["operation"]) =>
    owner.execute(input).pipe(Effect.mapError(failure(operation)));
  /** The owner's epoch and a fresh request id for one command. */
  const identity = Effect.map(crypto.uuidV4(), (requestId) => ({
    epoch: owner.epoch,
    requestId,
  }));
  const save = identity.pipe(
    Effect.flatMap((id) => command(OwnerCommand.cases.save.make(id), "save")),
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
      const chunkIds = EffectArray.filterMap(ids, (text) => {
        const id = Number(text);
        return id >= chunkVectorIdFloor ? Result.succeed(id) : Result.failVoid;
      });
      const parents = yield* mappings("vector_id", chunkIds);
      const parentOf = HashMap.fromIterable(
        Iterable.map(parents, (row) => [row.vector_id, row.node_seq] as const),
      );
      return EffectArray.dedupeWith(
        ids.flatMap((id, rank): VectorHit[] => {
          const native = Number(id);
          const seq =
            native < chunkVectorIdFloor ? Option.some(native) : HashMap.get(parentOf, native);
          return Option.toArray(Option.map(seq, (found) => ({ seq: found, score: scores[rank]! })));
        }),
        (left, right) => left.seq === right.seq,
      );
    });

  // The owner runs one command at a time, so per-id commands only add round trips and let other
  // commands interleave between them. Like add, a batch is a single owner step.
  const removeIds = (ids: readonly number[]) =>
    ids.length === 0
      ? Effect.void
      : identity.pipe(
          Effect.flatMap((id) =>
            command(OwnerCommand.cases.remove.make({ ...id, ids: ids.map(String) }), "remove"),
          ),
          Effect.asVoid,
        );
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
  yield* Effect.when(flush, Effect.succeed(!owner.initialNeedsReset));
  const reserved = yield* seqsOf(sql`
    SELECT c.vector_id AS seq FROM node_vector_chunks c
    LEFT JOIN node_vectors v ON v.node_seq = c.node_seq AND v.embedder = c.embedder
    WHERE c.embedder = ${embedder.identity} AND v.node_seq IS NULL`).pipe(
    Effect.mapError(failure("open")),
  );
  yield* Effect.when(
    Effect.gen(function* () {
      yield* Effect.when(
        Effect.andThen(removeIds(reserved), save),
        Effect.succeed(!owner.initialNeedsReset),
      );
      // Deleting a mapping journals its id for removal. These ids are already gone natively (or
      // the reset below drops everything), so the journal entry is acknowledged in the same step.
      yield* sql
        .withTransaction(Effect.all([deleteChunks(reserved), ackChunkRemovals(reserved)]))
        .pipe(Effect.mapError(failure("open")));
    }),
    Effect.succeed(reserved.length > 0),
  );
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
    yield* Effect.when(save, Effect.succeed(owner.size() === indexed));
  }
  if (owner.initialNeedsReset || owner.size() !== indexed) {
    yield* command(OwnerCommand.cases.reset.make(yield* identity), "open");
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
  // The lexical index is rebuilt from every node when its build is not the one the journal leads
  // to: a new or replaced folder, or a journal written for another build. The index is emptied
  // and named first, so a stop before the journal is rewritten only rebuilds again.
  const recordedLexical = yield* sql`SELECT instance FROM lexical_index`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ instance: Schema.String }))),
    ),
    Effect.map((rows) => rows[0]?.instance ?? null),
    Effect.mapError(failure("open")),
  );
  const rebuildLexical = Effect.gen(function* () {
    const instance = yield* crypto.uuidV7();
    yield* command(
      OwnerCommand.cases["lexical-reset"].make({ ...(yield* identity), instance }),
      "open",
    );
    yield* sql
      .withTransaction(
        Effect.all([
          sql`DELETE FROM lexical_changes`,
          // Newest first, so the latest conversations are searchable soonest.
          sql`INSERT INTO lexical_changes (node_seq) SELECT seq FROM nodes ORDER BY seq DESC`,
          sql`INSERT INTO lexical_index (one, instance) VALUES (1, ${instance})
            ON CONFLICT (one) DO UPDATE SET instance = excluded.instance`,
        ]),
      )
      .pipe(Effect.mapError(failure("open")));
  });
  yield* Effect.when(
    rebuildLexical,
    Effect.succeed(
      owner.initialLexical.pipe(
        Option.exists(({ instance }) => instance === null || instance !== recordedLexical),
      ),
    ),
  );
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
        ...(yield* identity),
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
    applyLexical: (documents: readonly LexicalDocument[], removed: readonly number[]) =>
      identity.pipe(
        Effect.flatMap((id) =>
          command(
            OwnerCommand.cases["lexical-apply"].make({ ...id, documents, removed }),
            "lexical",
          ),
        ),
        Effect.asVoid,
      ),
    flushRemovals: publication.withMutation(flush, publicationError),
    add,
    remove,
    save,
    publish: (prepare) =>
      publication.withMutation(
        Effect.gen(function* () {
          const { seqs, vectors, commit } = yield* prepare;
          yield* Effect.when(
            add(seqs, vectors).pipe(Effect.andThen(save)),
            Effect.succeed(seqs.length > 0),
          );
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
              ...(yield* identity),
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
        yield* Effect.when(
          Effect.fail(publicationError(NativeOwnerFailed.make({ reason: "invalid-input" }))),
          Effect.succeed(input.embedder !== embedder.identity),
        );
        const id = yield* identity;
        const { publication: current, result } = yield* publication
          .read(() => owner.startRead(OwnerCommand.cases["memory-search"].make({ ...id, input })))
          .pipe(Effect.mapError(publicationError));
        if (!OwnerReply.guards["memory-result"](result)) return yield* publicationError(result);
        return { publication: current, result: result.result };
      }),
    },
  };
  return api;
});

/**
 * The sole application vector backend: VectorIndex over the native owner of the active embedder's
 * index and that owner's publication gate, all released with the application's Scope.
 */
export const nativeVectorIndexLayer = Layer.effect(VectorIndex, makeNativeVectorIndex).pipe(
  Layer.provide(NativePublication.layer.pipe(Layer.provideMerge(nativeOwnerLayer))),
  Layer.provide(Layer.merge(NodeCrypto.layer, NodePath.layer)),
);
