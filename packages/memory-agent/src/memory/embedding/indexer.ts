import { Result, Function as EffectFunction } from "effect";
import { Semaphore } from "effect";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../../db/database.ts";
import { AppEvents } from "../../events/app-events.ts";
import { MorphAnalyzer } from "../morph/analyzer.ts";
import { meaningfulNodeFilter } from "../quality.ts";
import type { NodeKind } from "../nodes.ts";
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
  reason: Schema.Literals(["revalidation-failed", "mapping-commit-failed"]),
}) {}

const Pending = Schema.Struct({ seq: Schema.Finite, text: Schema.String });
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodePending = EffectFunction.flow(Schema.decodeUnknownResult(Pending), Result.getOrThrow);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeCount = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Struct({ count: Schema.Finite })),
  Result.getOrThrow,
);

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const events = yield* AppEvents;
  const embedder = yield* Embedder;
  const vectors = yield* VectorIndex;
  const analyzer = yield* MorphAnalyzer;

  // Newest by the time the statement was made, not by the order rows landed here. A migrated
  // transcript arrives with high seqs and old times; without this it would be indexed ahead of the
  // conversation just held, and a backlog of thousands would push today's words to the back.
  const selectPending = sqlite.prepare(`
    SELECT n.seq, n.text FROM nodes n
    LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
    WHERE v.node_seq IS NULL AND ${meaningfulNodeFilter} AND ${embeddedKindFilter}
    ORDER BY n.created_at DESC, n.seq DESC LIMIT ?`);
  const markIndexed = sqlite.prepare("INSERT INTO node_vectors VALUES (?, ?)");
  const countPending = sqlite.prepare(`
    SELECT count(*) AS count FROM nodes n
    LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
    WHERE v.node_seq IS NULL AND ${meaningfulNodeFilter} AND ${embeddedKindFilter}`);
  const selectUnanalyzed = sqlite.prepare(`
    SELECT n.seq, n.text FROM nodes n
    LEFT JOIN node_morphs m ON m.node_seq = n.seq AND m.analyzer = ?
    WHERE m.node_seq IS NULL AND ${meaningfulNodeFilter}
    ORDER BY n.created_at DESC, n.seq DESC LIMIT ?`);
  const deleteTerms = sqlite.prepare("DELETE FROM nodes_morph WHERE rowid = ?");
  const insertTerms = sqlite.prepare("INSERT INTO nodes_morph (rowid, terms) VALUES (?, ?)");
  const markAnalyzed = sqlite.prepare(
    "INSERT INTO node_morphs (node_seq, analyzer) VALUES (?, ?) ON CONFLICT (node_seq) DO UPDATE SET analyzer = excluded.analyzer",
  );
  const oneMorphBatchAtATime = yield* Semaphore.make(1);
  // Runs end concurrently; two batches picking the same pending nodes would index them twice.
  const oneBatchAtATime = yield* Semaphore.make(1);

  /** Embeds one batch of not-yet-indexed nodes. Returns how many were indexed. */
  const indexBatch = (limit: number) =>
    Effect.gen(function* () {
      const pending = selectPending.all(embedder.identity, limit).map((row) => decodePending(row));
      if (pending.length === 0) return 0;
      const texts = pending.map((node) => node.text);
      const spans = embedder.chunks === undefined ? undefined : yield* embedder.chunks(texts);
      const inputs = pending.flatMap((node, row) =>
        spans === undefined
          ? [{ node, ordinal: 0, start: 0, end: node.text.length }]
          : spans[row]!.map((span, ordinal) => ({ node, ordinal, ...span })),
      );
      const embedded = yield* embedder.embed(
        inputs.map(({ node, start, end }) => node.text.slice(start, end)),
      );
      // Embedding is an asynchronous external boundary. Revalidation enters the short publication
      // permit with add/save/commit, so a concurrent invalidation cannot create an obsolete mapping.
      const published = yield* vectors.publish(
        Effect.gen(function* () {
          const fresh = yield* Effect.try({
            try: () =>
              sqlite
                .prepare(`
            SELECT n.seq, n.text FROM nodes n
            LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
            WHERE v.node_seq IS NULL AND ${meaningfulNodeFilter} AND ${embeddedKindFilter}
              AND n.seq IN (${pending.map(() => "?").join(",")})`)
                .all(embedder.identity, ...pending.map((node) => node.seq))
                .map((row) => decodePending(row)),
            catch: () => IndexingError.make({ reason: "revalidation-failed" }),
          });
          const accepted = inputs.flatMap(({ node, ordinal, start, end }, row) =>
            fresh.some((current) => current.seq === node.seq && current.text === node.text)
              ? [{ seq: node.seq, vector: embedded[row]!, ordinal, start, end }]
              : [],
          );
          const nodeSeqs = [...new Set(accepted.map((node) => node.seq))];
          // Reserve mappings inside the publication gate, before saving vectors. Only node_vectors
          // marks a fully committed node. Startup removes reserved chunks without that marker.
          const seqs =
            spans === undefined
              ? nodeSeqs
              : yield* Effect.try({
                  try: () =>
                    atomic(() =>
                      accepted.map((chunk) =>
                        Number(
                          sqlite
                            .prepare(
                              "INSERT INTO node_vector_chunks(node_seq,embedder,ordinal,start_offset,end_offset) VALUES (?,?,?,?,?)",
                            )
                            .run(
                              chunk.seq,
                              embedder.identity,
                              chunk.ordinal,
                              chunk.start,
                              chunk.end,
                            ).lastInsertRowid,
                        ),
                      ),
                    ),
                  catch: () => IndexingError.make({ reason: "mapping-commit-failed" }),
                });
          return {
            seqs,
            vectors: accepted.map((node) => node.vector),
            commit: Effect.try({
              try: () =>
                atomic(() => {
                  for (const seq of nodeSeqs) markIndexed.run(seq, embedder.identity);
                  return nodeSeqs.length;
                }),
              catch: () => IndexingError.make({ reason: "mapping-commit-failed" }),
            }),
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
      const pending = selectUnanalyzed
        .all(analyzer.identity, limit)
        .map((row) => decodePending(row));
      if (pending.length === 0) return 0;
      const terms = yield* analyzer.terms(pending.map((node) => node.text));
      atomic(() => {
        pending.forEach((node, index) => {
          deleteTerms.run(node.seq);
          insertTerms.run(node.seq, (terms[index] ?? []).join(" "));
          markAnalyzed.run(node.seq, analyzer.identity);
        });
      });
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
    pending: Effect.sync(() => decodeCount(countPending.get(embedder.identity)).count),
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
