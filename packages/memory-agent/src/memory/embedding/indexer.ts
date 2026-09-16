import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../../db/database.ts";
import { MorphAnalyzer } from "../morph/analyzer.ts";
import { Embedder } from "./embedder.ts";
import { VectorIndex } from "./vector-index.ts";

const Pending = Schema.Struct({ seq: Schema.Number, text: Schema.String });
const decodePending = Schema.decodeUnknownSync(Pending);
const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));

const make = Effect.gen(function* () {
  const { sqlite, atomic } = yield* Database;
  const embedder = yield* Embedder;
  const vectors = yield* VectorIndex;
  const analyzer = yield* MorphAnalyzer;

  // Newest by the time the statement was made, not by the order rows landed here. A migrated
  // transcript arrives with high seqs and old times; without this it would be indexed ahead of the
  // conversation just held, and a backlog of thousands would push today's words to the back.
  const selectPending = sqlite.prepare(`
    SELECT n.seq, n.text FROM nodes n
    LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
    WHERE v.node_seq IS NULL AND length(n.text) > 0
    ORDER BY n.created_at DESC, n.seq DESC LIMIT ?`);
  const markIndexed = sqlite.prepare("INSERT INTO node_vectors VALUES (?, ?)");
  const countPending = sqlite.prepare(`
    SELECT count(*) AS count FROM nodes n
    LEFT JOIN node_vectors v ON v.node_seq = n.seq AND v.embedder = ?
    WHERE v.node_seq IS NULL AND length(n.text) > 0`);
  const selectUnanalyzed = sqlite.prepare(`
    SELECT n.seq, n.text FROM nodes n
    LEFT JOIN node_morphs m ON m.node_seq = n.seq AND m.analyzer = ?
    WHERE m.node_seq IS NULL AND length(n.text) > 0
    ORDER BY n.created_at DESC, n.seq DESC LIMIT ?`);
  const deleteTerms = sqlite.prepare("DELETE FROM nodes_morph WHERE rowid = ?");
  const insertTerms = sqlite.prepare("INSERT INTO nodes_morph (rowid, terms) VALUES (?, ?)");
  const markAnalyzed = sqlite.prepare(
    "INSERT INTO node_morphs (node_seq, analyzer) VALUES (?, ?) ON CONFLICT (node_seq) DO UPDATE SET analyzer = excluded.analyzer",
  );
  const oneMorphBatchAtATime = yield* Effect.makeSemaphore(1);
  // Runs end concurrently; two batches picking the same pending nodes would index them twice.
  const oneBatchAtATime = yield* Effect.makeSemaphore(1);

  /** Embeds one batch of not-yet-indexed nodes. Returns how many were indexed. */
  const indexBatch = (limit: number) =>
    Effect.gen(function* () {
      const pending = selectPending.all(embedder.identity, limit).map((row) => decodePending(row));
      if (pending.length === 0) return 0;
      const embedded = yield* embedder.embed(pending.map((node) => node.text));
      const seqs = pending.map((node) => node.seq);
      yield* vectors.add(seqs, embedded);
      // Save before recording: a crash in between leaves the index ahead, which reopen detects.
      yield* vectors.save();
      atomic(() => {
        for (const seq of seqs) markIndexed.run(seq, embedder.identity);
      });
      return pending.length;
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
    Effect.iterate(
      { total: 0, last: -1 },
      {
        while: (state) => state.last !== 0 && state.total < budget,
        body: (state) =>
          Effect.map(work(Math.min(batchSize, budget - state.total)), (count) => ({
            total: state.total + count,
            last: count,
          })),
      },
    ).pipe(Effect.map((state) => state.total));

  return {
    /** Nodes this embedder has not embedded yet; vectors of other embedders do not count. */
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
export class Indexer extends Context.Tag("memory-agent/Indexer")<
  Indexer,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Indexer, make);
}
