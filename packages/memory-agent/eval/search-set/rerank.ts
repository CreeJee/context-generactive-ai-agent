/**
 * A local cross-encoder reranker over other runs' results, as a run of its own. An item's
 * candidates are the first `depth` ids of each candidate run, merged in turns without repeats; the
 * reranker scores every (query, node text) pair of the item in one batch, and the run lists the
 * candidates by that score. The candidate runs already keep only what the item may read (its
 * projects, and the nodes stored before a recorded question), so the reranked run does too. The
 * model is a Hugging Face sequence classification model with one relevance logit, loaded with
 * transformers.js as the app's embedder is; its files are downloaded into the copy's
 * `rerank-models/` folder, and no node text leaves the machine. Prints how long each item's batch
 * took, tokenizing included, as the app would spend it on a read.
 */
import { createRequire } from "node:module";
import type { Tensor } from "@huggingface/transformers";
import { Array as Arr, Console, Duration, Effect, HashMap, Option, Order, Schema } from "effect";
import { nativePromise } from "../../src/runtime/native-effect.ts";
import { path } from "../../src/runtime/synchronous-path.ts";
import { appendRows, readRows, type RunRow, setFiles } from "./files.ts";
import { nodeRecords } from "./nodes.ts";
import { alternate, keptIds } from "./pool.ts";

/** The app's whole read budget, which a rerank inside the read would share. */
const readBudgetMs = 2_000;

const percentile = (share: number) => (sorted: ReadonlyArray<number>) =>
  sorted[Math.round((sorted.length - 1) * share)] ?? 0;

// The CommonJS build, as the embedding worker loads it.
const {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
}: typeof import("@huggingface/transformers") = createRequire(import.meta.url)(
  "@huggingface/transformers",
);

export const RerankDevice = Schema.Literals(["cpu", "webgpu"]);
export const RerankDtype = Schema.Literals(["fp32", "fp16", "q8", "int8", "q4", "q4f16"]);

export interface RerankOptions {
  readonly storage: string;
  /** The run to write. */
  readonly name: string;
  /** The reranker's Hugging Face model id. */
  readonly model: string;
  readonly candidates: ReadonlyArray<string>;
  /** Ids taken from the top of each candidate run. */
  readonly depth: number;
  /** Tokens of one pair, query and node text together; the longer side is cut first. */
  readonly maxTokens: number;
  readonly dtype: typeof RerankDtype.Type;
  readonly device: typeof RerankDevice.Type;
}

/** The model returned more than one logit per pair: not a single-score reranker. */
class NotOneLogit extends Schema.TaggedError<NotOneLogit, { readonly brand: unique symbol }>()(
  "NotOneLogit",
  {
    dims: Schema.Array(Schema.Finite),
  },
) {}

const loadReranker = Effect.fn("searchSet.loadReranker")(function* ({
  storage,
  model,
  dtype,
  device,
}: RerankOptions) {
  env.cacheDir = path.join(storage, "rerank-models");
  const tokenizer = yield* nativePromise(() => AutoTokenizer.from_pretrained(model));
  const classifier = yield* Effect.acquireRelease(
    nativePromise(() =>
      AutoModelForSequenceClassification.from_pretrained(model, { dtype, device }),
    ),
    (loaded) => Effect.ignore(nativePromise(() => loaded.dispose())),
  );
  return { tokenizer, classifier };
});
type Reranker = Effect.Success<ReturnType<typeof loadReranker>>;

/** One relevance score per text, and the batch's padded length in tokens. */
const scorePairs = Effect.fn("searchSet.scorePairs")(function* (
  { tokenizer, classifier }: Reranker,
  query: string,
  texts: ReadonlyArray<string>,
  maxTokens: number,
) {
  const inputs = tokenizer(
    texts.map(() => query),
    { text_pair: [...texts], padding: true, truncation: true, max_length: maxTokens },
  );
  // An interrupted batch still waits for its session run, so the model is never disposed of
  // while a run is in flight.
  const { logits } = yield* Effect.uninterruptible(
    nativePromise<{ readonly logits: Tensor }>(() => classifier(inputs)),
  );
  const dims: ReadonlyArray<number> = logits.dims;
  if (dims[1] !== 1) return yield* NotOneLogit.make({ dims });
  return { scores: Array.from(logits.data, Number), tokens: inputs.input_ids.dims.at(-1) ?? 0 };
});

/** One item's reranked row, and its batch's time and padded length when it had candidates. */
interface Reranked {
  readonly row: RunRow;
  readonly batch: Option.Option<{ readonly ms: number; readonly tokens: number }>;
}

const byScore = Order.mapInput(
  Order.flip(Order.Number),
  (scored: { readonly score: number }) => scored.score,
);

export const rerankRun = Effect.fn("searchSet.rerank")(function* (options: RerankOptions) {
  const files = setFiles(options.storage);
  const done = new Set((yield* readRows(files.run(options.name))).map((row) => row.item));
  const lists = yield* Effect.forEach(options.candidates, (run) =>
    Effect.map(readRows(files.run(run)), (rows) =>
      HashMap.fromIterable(rows.map((row) => [row.item, row.ids] as const)),
    ),
  );
  const items = (yield* readRows(files.items)).filter((item) => !done.has(item.item));
  yield* Console.log(`items to rerank ${items.length}`);
  const reranker = yield* loadReranker(options);
  // The first batch also compiles the device's kernels; it is not one an item would wait for.
  yield* scorePairs(reranker, "준비", ["준비"], options.maxTokens);

  const reranked = yield* Effect.forEach(items, (item) =>
    Effect.gen(function* () {
      const candidates = Arr.dedupe(
        alternate(
          lists.map((run) =>
            Option.getOrElse(HashMap.get(run, item.item), () => []).slice(0, options.depth),
          ),
        ),
      );
      const nodes = yield* nodeRecords(candidates);
      if (!Arr.isReadonlyArrayNonEmpty(nodes))
        return { row: { item: item.item, ids: [] }, batch: Option.none() } satisfies Reranked;
      const [took, { scores, tokens }] = yield* Effect.timed(
        scorePairs(
          reranker,
          item.query,
          nodes.map((node) => node.text),
          options.maxTokens,
        ),
      );
      const ids = Arr.sort(
        nodes.map((node, index) => ({ id: node.id, score: scores[index] ?? -Infinity })),
        byScore,
      ).map(({ id }) => id);
      return {
        row: { item: item.item, ids: ids.slice(0, keptIds) },
        batch: Option.some({ ms: Duration.toMillis(took), tokens }),
      } satisfies Reranked;
    }).pipe(Effect.tap(({ row }) => appendRows(files.run(options.name))([row]))),
  );

  const batches = Arr.getSomes(reranked.map((result) => result.batch));
  const ms = Arr.sort(
    batches.map((batch) => batch.ms),
    Order.Number,
  );
  const mean = (values: ReadonlyArray<number>) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  yield* Console.log(
    `${options.name}: reranked ${ms.length}; p50 ${percentile(0.5)(ms).toFixed(0)} ms; ` +
      `p95 ${percentile(0.95)(ms).toFixed(0)} ms; max ${percentile(1)(ms).toFixed(0)} ms; ` +
      `mean ${mean(ms).toFixed(0)} ms; over ${readBudgetMs} ms ` +
      `${Arr.countBy(ms, (each) => each > readBudgetMs)}; candidates per item ` +
      `${mean(reranked.map((result) => result.row.ids.length)).toFixed(1)}; padded tokens ` +
      `${mean(batches.map((batch) => batch.tokens)).toFixed(0)}`,
  );
}, Effect.scoped);
