/**
 * Measures the vector index's 4-bit quantization loss on a copy of a real storage folder.
 *
 *   node --no-warnings eval/quantization-loss.ts <storage copy> [--nodes 2000] [--queries 40]
 *     [--json <file>]
 *
 * Re-embeds sampled node texts with the model variant that made the copy's vectors, adds those
 * vectors to a fresh 4-bit index (the same quantization the production index stores), and compares,
 * per query, the exact inner-product ranking with the 4-bit ranking over the same vectors. Numbers
 * only: the app keeps its quantization (docs/decisions.md 2026-10-18); this records what it costs,
 * it does not change it. Query vectors come from the copy's relevance set when it exists, else
 * from the project's newest user texts. Nothing it reads is printed but counts and scores.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Console, Effect, Layer, Schema } from "effect";
import { loadTurbovec } from "../../turbovec/index.js";
import { runNativeEffect } from "../src/runtime/native-effect.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { Embedder, type ModelVariant } from "../src/memory/embedding/embedder.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv.splice(at, 2)[1];
};
const nodeCount = Number(flag("--nodes") ?? "2000");
const queryCount = Number(flag("--queries") ?? "40");
const jsonOut = flag("--json");
const storage = argv[0];
if (storage === undefined) {
  console.error(
    "usage: quantization-loss.ts <storage copy> [--nodes 2000] [--queries 40] [--json <file>]",
  );
  process.exit(2);
}

const db = new DatabaseSync(join(storage, "agent.db"), { readOnly: true });
const top = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ embedder: Schema.String, n: Schema.Number })),
)(
  db
    .prepare(
      "SELECT embedder, count(*) AS n FROM node_vectors GROUP BY embedder ORDER BY n DESC LIMIT 1",
    )
    .all(),
)[0];
if (top === undefined) throw new Error("no vectors in the copy");
// The variant that made the copy's vectors, read from the identity's variant segment: the app
// re-embeds with the same weights, so the exact ranking is over production's own vectors.
const variant: ModelVariant = top.embedder.includes("@fp32/") ? "fp32" : "quint8";
const project = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ project_id: Schema.String })),
)(
  db
    .prepare(
      "SELECT project_id, count(*) AS n FROM nodes GROUP BY project_id ORDER BY n DESC LIMIT 1",
    )
    .all(),
)[0]!.project_id;
const texts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
  db
    .prepare(
      // substr keeps a whole-node sample within the model's token window: the production indexer
      // would chunk longer texts, and a truncated re-embedding would not be its ground truth.
      "SELECT substr(text, 1, 4000) AS text FROM nodes WHERE project_id = ? AND length(trim(text)) > 0 ORDER BY seq DESC LIMIT ?",
    )
    .all(project, nodeCount),
).map((row) => row.text);

const QueryItem = Schema.Struct({
  group: Schema.Literals(["find", "recall"]),
  query: Schema.String,
});
let queries: string[] = [];
try {
  const items = readFileSync(join(storage, "relevance.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => Schema.decodeUnknownSync(QueryItem)(JSON.parse(line)));
  queries = items.map((item) => item.query);
} catch {
  // No relevance set in this copy: user texts stand in.
}
if (queries.length < queryCount)
  queries.push(
    ...Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
      db
        .prepare(
          "SELECT text FROM nodes WHERE project_id = ? AND kind = 'user' AND length(trim(text)) > 0 ORDER BY seq DESC LIMIT ?",
        )
        .all(project, queryCount - queries.length),
    ).map((row) => row.text),
  );
queries = queries.slice(0, queryCount);
db.close();

interface QueryRow {
  readonly overlap5: number;
  readonly overlap12: number;
  readonly top1Same: boolean;
  readonly exactTop1QuantRank: number;
  readonly deltaMean: number;
  readonly deltaMax: number;
  readonly searchMs: number;
  readonly exactMs: number;
}
const rows: QueryRow[] = [];

const program = Effect.gen(function* () {
  const embedder = yield* Embedder;
  if (embedder.identity !== top.embedder)
    yield* Effect.die(`embedder ${embedder.identity} does not match the copy (${top.embedder})`);
  const vectors = yield* embedder.embed(texts);
  const queryVectors = yield* embedder.embed(queries);
  // The production quantization, applied to the same vectors the exact ranking uses.
  const { VectorIndex } = loadTurbovec();
  const index = new VectorIndex(embedder.dimensions, 4);
  const flat = new Float32Array(vectors.length * embedder.dimensions);
  vectors.forEach((vector, position) => flat.set(vector, position * embedder.dimensions));
  const ids = vectors.map((_, position) => String(position));
  index.add(flat, ids);
  const dot = (a: Float32Array, b: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
    return sum;
  };
  yield* Effect.forEach(
    queries,
    (query, queryIndex) =>
      Effect.sync(() => {
        const q = queryVectors[queryIndex]!;
        const exactStarted = performance.now();
        const exact = vectors
          .map((vector, position) => ({ position, score: dot(q, vector) }))
          .sort((a, b) => b.score - a.score);
        const exactMs = performance.now() - exactStarted;
        const searchStarted = performance.now();
        const hits = index.search(q, Math.min(12, vectors.length));
        const searchMs = performance.now() - searchStarted;
        const quantOrder = hits.ids.map((id) => Number(id));
        const quantSet = new Set(quantOrder);
        const overlap = (limit: number) => {
          const head = new Set(exact.slice(0, limit).map((entry) => entry.position));
          let shared = 0;
          for (const position of head) if (quantSet.has(position)) shared++;
          return shared / Math.min(limit, vectors.length);
        };
        const exactTop1 = exact[0]!.position;
        const quantRank = quantOrder.indexOf(exactTop1);
        const exactScore = new Map(exact.map((entry) => [entry.position, entry.score] as const));
        const deltas = quantOrder.map((position, rank) =>
          Math.abs(hits.scores[rank]! - (exactScore.get(position) ?? 0)),
        );
        rows.push({
          overlap5: overlap(5),
          overlap12: overlap(12),
          top1Same: quantOrder[0] === exactTop1,
          exactTop1QuantRank: quantRank < 0 ? -1 : quantRank + 1,
          deltaMean:
            deltas.length === 0 ? 0 : deltas.reduce((sum, d) => sum + d, 0) / deltas.length,
          deltaMax: deltas.length === 0 ? 0 : Math.max(...deltas),
          searchMs,
          exactMs,
        });
      }),
    { discard: true },
  );
  const mean = (values: readonly number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const quantRankValues = rows.map((row) => row.exactTop1QuantRank).filter((rank) => rank > 0);
  yield* Console.log(
    [
      `nodes ${vectors.length} (project ${project.slice(0, 8)}…), queries ${rows.length}, ${top.embedder} -> ${variant}, fresh index bits 4`,
      `| 4-bit vs exact | overlap@5 ${mean(rows.map((row) => row.overlap5)).toFixed(3)} | overlap@12 ${mean(rows.map((row) => row.overlap12)).toFixed(3)} | top1 same ${(mean(rows.map((row) => (row.top1Same ? 1 : 0))) * 100).toFixed(1)}% | exact-top1 quant rank mean ${(quantRankValues.length === 0 ? 0 : mean(quantRankValues)).toFixed(2)} (lost ${rows.length - quantRankValues.length}) | Δscore mean ${mean(rows.map((row) => row.deltaMean)).toExponential(2)} max ${Math.max(0, ...rows.map((row) => row.deltaMax)).toExponential(2)} | 4-bit ${mean(rows.map((row) => row.searchMs)).toFixed(2)} ms | exact ${mean(rows.map((row) => row.exactMs)).toFixed(2)} ms |`,
    ].join("\n"),
  );
  if (jsonOut !== undefined)
    writeFileSync(jsonOut, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  index.close();
}).pipe(
  Effect.provide(Embedder.localVariant(variant).pipe(Layer.provide(StorageRoot.layer(storage)))),
);

await runNativeEffect(program);
