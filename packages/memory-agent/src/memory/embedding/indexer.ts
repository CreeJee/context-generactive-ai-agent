import { Context, Data, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { AppEvents } from "../../events/app-events.ts";
import { MorphAnalyzer } from "../morph/analyzer.ts";
import { meaningfulNodeFilter } from "../quality.ts";
import type { NodeKind } from "../nodes.ts";
import type { ChunkSpan } from "./chunks.ts";
import { Embedder } from "./embedder.ts";
import { VectorIndex } from "./vector-index.ts";

/**
 * Kinds whose text is embedded: what people and the model said, and topics. Tool calls and results
 * are found by text match and reached from the statements around them; embedding them took most of
 * the indexing time and crowded statements out of the vector ranking (docs/decisions.md).
 */
export const embeddedKinds = ["user", "assistant", "topic"] as const satisfies readonly NodeKind[];

/** `n.kind` limited to {@link embeddedKinds}, for queries over nodes aliased `n`. */
export const embeddedKindFilter = `n.kind IN (${embeddedKinds.map((kind) => `'${kind}'`).join(", ")})`;

export class IndexingError extends Schema.TaggedError<IndexingError>()("IndexingError", {
  reason: Schema.Literals(["read-failed", "revalidation-failed", "mapping-commit-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {}

const Pending = Schema.Struct({ seq: Schema.Finite, text: Schema.String });
type Pending = typeof Pending.Type;

/** How one batch is cut before embedding: whole nodes, or the embedder's chunk windows. */
type Segmentation = Data.TaggedEnum<{
  whole: {};
  chunked: { readonly spans: readonly (readonly ChunkSpan[])[] };
}>;
const Segmentation = Data.taggedEnum<Segmentation>();

/** What the publication commit does with one node, decided in the commit's own transaction. */
type NodeOutcome = Data.TaggedEnum<{
  indexed: { readonly seq: number };
  "stale-chunks": { readonly vectorIds: readonly number[] };
  "stale-whole": { readonly seq: number };
}>;
const NodeOutcome = Data.taggedEnum<NodeOutcome>();

const failed = (reason: IndexingError["reason"]) => (cause: unknown) =>
  IndexingError.make({ reason, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* AppEvents;
  const embedder = yield* Embedder;
  const vectors = yield* VectorIndex;
  const analyzer = yield* MorphAnalyzer;

  const unindexed = sql.literal(
    `v.node_seq IS NULL AND ${meaningfulNodeFilter} AND ${embeddedKindFilter}`,
  );
  // Newest by the time the statement was made, not by the order rows landed here. A migrated
  // transcript arrives with high seqs and old times; without this it would be indexed ahead of the
  // conversation just held, and a backlog of thousands would push today's words to the back.
  const selectPending = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Pending,
    execute: (limit) => sql`
      SELECT n.seq, n.text FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${embedder.identity}
      WHERE ${unindexed}
      ORDER BY n.created_at DESC, n.seq DESC LIMIT ${limit}`,
  });
  const selectFresh = SqlSchema.findAll({
    Request: Schema.Array(Schema.Finite),
    Result: Pending,
    execute: (seqs) => sql`
      SELECT n.seq, n.text FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${embedder.identity}
      WHERE ${unindexed} AND n.seq IN ${sql.in(seqs)}`,
  });
  const selectUnindexed = SqlSchema.findOneOption({
    Request: Schema.Finite,
    Result: Pending,
    execute: (seq) => sql`
      SELECT n.seq, n.text FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${embedder.identity}
      WHERE n.seq = ${seq} AND ${unindexed}`,
  });
  const countPending = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Finite }),
    execute: () => sql`
      SELECT count(*) AS count FROM nodes n
      LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ${embedder.identity}
      WHERE ${unindexed}`,
  });
  const reserveChunk = SqlSchema.findOne({
    Request: Schema.Struct({
      seq: Schema.Finite,
      ordinal: Schema.Finite,
      start: Schema.Finite,
      end: Schema.Finite,
    }),
    Result: Schema.Struct({ vector_id: Schema.Finite }),
    execute: (chunk) => sql`
      INSERT INTO node_vector_chunks(node_seq,embedder,ordinal,start_offset,end_offset)
      VALUES (${chunk.seq},${embedder.identity},${chunk.ordinal},${chunk.start},${chunk.end})
      RETURNING vector_id`,
  });
  const selectUnanalyzed = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Pending,
    execute: (limit) => sql`
      SELECT n.seq, n.text FROM nodes n
      LEFT JOIN node_morphs m ON m.node_seq = n.seq AND m.analyzer = ${analyzer.identity}
      WHERE m.node_seq IS NULL AND ${sql.literal(meaningfulNodeFilter)}
      ORDER BY n.created_at DESC, n.seq DESC LIMIT ${limit}`,
  });
  const oneMorphBatchAtATime = yield* Semaphore.make(1);
  // Runs end concurrently; two batches picking the same pending nodes would index them twice.
  const oneBatchAtATime = yield* Semaphore.make(1);

  /**
   * Re-reads one node inside the commit transaction. Only a node still unindexed with the text
   * that was embedded is published; anything else drops the native ids it was given.
   */
  const outcomeOf = (node: Pending, segmentation: Segmentation, vectorIds: readonly number[]) =>
    selectUnindexed(node.seq).pipe(
      Effect.map((current): NodeOutcome => {
        if (Option.exists(current, ({ text }) => text === node.text))
          return NodeOutcome.indexed({ seq: node.seq });
        return Segmentation.$match(segmentation, {
          whole: () => NodeOutcome["stale-whole"]({ seq: node.seq }),
          chunked: () => NodeOutcome["stale-chunks"]({ vectorIds }),
        });
      }),
    );

  /** Writes one outcome inside the caller's transaction. */
  const settle = NodeOutcome.$match({
    indexed: (outcome) =>
      sql`INSERT INTO node_vectors VALUES (${outcome.seq}, ${embedder.identity})`,
    // The deletion trigger preserves removal IDs even if a purge already cascaded these rows.
    // Uncommitted chunks never enter the search allowlist.
    "stale-chunks": (outcome) =>
      sql`DELETE FROM node_vector_chunks WHERE vector_id IN ${sql.in(outcome.vectorIds)}`,
    "stale-whole": (outcome) =>
      sql`INSERT OR IGNORE INTO memory_graph_vector_removals
          VALUES (${outcome.seq}, ${embedder.identity})`,
  });

  /** Embeds one batch of not-yet-indexed nodes. Returns how many were indexed. */
  const indexBatch = (limit: number) =>
    Effect.gen(function* () {
      const pending = yield* selectPending(limit).pipe(Effect.mapError(failed("read-failed")));
      if (pending.length === 0) return 0;
      // Chunking and embedding are both requests to the one model worker, which serves a single
      // request at a time, and embedding needs the spans: the steps are sequential by data.
      const segmentation: Segmentation =
        embedder.chunks === undefined
          ? Segmentation.whole()
          : Segmentation.chunked({
              spans: yield* embedder.chunks(pending.map((node) => node.text)),
            });
      const inputs = pending.flatMap((node, row) =>
        Segmentation.$match(segmentation, {
          whole: () => [{ node, ordinal: 0, start: 0, end: node.text.length }],
          chunked: ({ spans }) => spans[row]!.map((span, ordinal) => ({ node, ordinal, ...span })),
        }),
      );
      const embedded = yield* embedder.embed(
        inputs.map(({ node, start, end }) => node.text.slice(start, end)),
      );
      // Embedding is an asynchronous external boundary. Revalidation enters the short publication
      // permit with add/save/commit, so a concurrent invalidation cannot create an obsolete mapping.
      const published = yield* vectors.publish(
        Effect.gen(function* () {
          const fresh = yield* selectFresh(pending.map((node) => node.seq)).pipe(
            Effect.mapError(failed("revalidation-failed")),
          );
          const accepted = inputs.flatMap(({ node, ordinal, start, end }, row) =>
            fresh.some((current) => current.seq === node.seq && current.text === node.text)
              ? [{ node, vector: embedded[row]!, ordinal, start, end }]
              : [],
          );
          const acceptedNodes = pending.filter((node) =>
            accepted.some((chunk) => chunk.node.seq === node.seq),
          );
          // Reserve mappings inside the publication gate, before saving vectors. Only node_vectors
          // marks a fully committed node. Startup removes reserved chunks without that marker.
          // One connection runs a transaction's statements in order, so the inserts are sequential
          // and each RETURNING id lines up with its chunk.
          const ids = yield* Effect.suspend(() =>
            Segmentation.$match(segmentation, {
              whole: () => Effect.succeed(accepted.map((chunk) => chunk.node.seq)),
              chunked: () =>
                sql.withTransaction(
                  Effect.forEach(accepted, (chunk) =>
                    reserveChunk({ seq: chunk.node.seq, ...chunk }).pipe(
                      Effect.map(({ vector_id }) => vector_id),
                    ),
                  ),
                ),
            }),
          ).pipe(Effect.mapError(failed("mapping-commit-failed")));
          const idsOf = (node: Pending) =>
            accepted.flatMap((chunk, row) => (chunk.node.seq === node.seq ? [ids[row]!] : []));
          return {
            seqs: ids,
            vectors: accepted.map((chunk) => chunk.vector),
            // Native add/save yielded to other agents. A purge or redaction can have
            // removed/changed the source since prepare, without taking this publication gate.
            // Each node's re-read and its write share this transaction.
            commit: sql
              .withTransaction(
                Effect.forEach(acceptedNodes, (node) =>
                  outcomeOf(node, segmentation, idsOf(node)).pipe(Effect.tap(settle)),
                ),
              )
              .pipe(
                Effect.map((outcomes) =>
                  outcomes.reduce(
                    (committed, outcome) =>
                      NodeOutcome.$is("indexed")(outcome) ? committed + 1 : committed,
                    0,
                  ),
                ),
                Effect.mapError(failed("mapping-commit-failed")),
              ),
          };
        }),
      );
      if (published > 0) {
        events.publishGlobal("embedding");
        events.publishGlobal("imports");
      }
      return published;
    }).pipe(oneBatchAtATime.withPermits(1));

  /** Stores morpheme terms for one batch of nodes the current analyzer has not seen. */
  const analyzeBatch = (limit: number) =>
    Effect.gen(function* () {
      const pending = yield* selectUnanalyzed(limit).pipe(Effect.mapError(failed("read-failed")));
      if (pending.length === 0) return 0;
      const terms = yield* analyzer.terms(pending.map((node) => node.text));
      yield* sql
        .withTransaction(
          Effect.forEach(
            pending,
            (node, index) =>
              Effect.all(
                [
                  sql`DELETE FROM nodes_morph WHERE rowid = ${node.seq}`,
                  sql`INSERT INTO nodes_morph (rowid, terms)
                    VALUES (${node.seq}, ${(terms[index] ?? []).join(" ")})`,
                  sql`INSERT INTO node_morphs (node_seq, analyzer) VALUES (${node.seq}, ${analyzer.identity})
                    ON CONFLICT (node_seq) DO UPDATE SET analyzer = excluded.analyzer`,
                ],
                { discard: true },
              ),
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(failed("mapping-commit-failed")));
      return pending.length;
    }).pipe(oneMorphBatchAtATime.withPermits(1));

  /** Runs `work` in batches until nothing is pending or `budget` nodes have been done. */
  const drain = <E>(
    work: (limit: number) => Effect.Effect<number, E>,
    budget: number,
    batchSize: number,
  ) =>
    Effect.gen(function* () {
      let total = 0;
      let last = -1;
      while (last !== 0 && total < budget) {
        last = yield* work(Math.min(batchSize, budget - total));
        total += last;
      }
      return total;
    });

  return {
    /**
     * Statements this embedder has not embedded yet; vectors of other embedders do not count, and
     * tool calls and results are never embedded.
     */
    pending: countPending().pipe(
      Effect.map(({ count }) => count),
      Effect.mapError(failed("read-failed")),
    ),
    indexBatch,
    analyzeBatch,
    /**
     * Stores morpheme terms until nothing is pending. Fails when the analyzer is unavailable (no
     * model, disabled); search then simply works without these terms.
     */
    analyzeAll: (batchSize = 256) => drain(analyzeBatch, Number.POSITIVE_INFINITY, batchSize),
    /** Indexes until nothing is pending. */
    indexAll: (batchSize = 64) => drain(indexBatch, Number.POSITIVE_INFINITY, batchSize),

    /**
     * Indexes at most `budget` nodes. A run's own nodes are the newest, so they are always in the
     * first batches; the rest of a migrated backlog waits for the fibre that drains it.
     */
    indexUpTo: (budget: number, batchSize = 64) => drain(indexBatch, budget, batchSize),
    analyzeUpTo: (budget: number, batchSize = 256) => drain(analyzeBatch, budget, batchSize),

    /**
     * Runs `work` while no batch is embedding or analysing. For changing a node's text: a batch
     * picks a node, works on its text and records the result, and a change in the middle of that
     * would leave the index holding the text as it was.
     */
    exclusive: <A, E, R>(work: Effect.Effect<A, E, R>) =>
      work.pipe(oneBatchAtATime.withPermits(1), oneMorphBatchAtATime.withPermits(1)),
  };
});

/** Keeps the vector index in step with the nodes table. */
export class Indexer extends Context.Service<Indexer, Effect.Success<typeof make>>()(
  "memory-agent/memory/embedding/indexer",
) {
  static readonly layer = Layer.effect(Indexer, make);
}
