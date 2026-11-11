/**
 * The app's reranker over the candidates the app's search gives it, with its input made in several
 * ways: each way is a run `<name>-<variant>`. The candidates are the first `depth` ids of the native
 * read's vector, morph and text lists in turns, as `MemorySearch` reranks them. The variants differ
 * in three things:
 *
 * - the query: the item's own; the turn path's (`turnQuery`: the latest statement first); the latest
 *   statement alone; or each statement on its own, a text keeping its best score. Items that are
 *   not recall needs have one query, so all four are the item's.
 * - how a pair longer than the model reads is cut (`PairCut`).
 * - how pairs go to the model: one batch padded to the longest pair, as the app runs them; each pair
 *   alone, which no padding can move; or two batches split by length where the padding is least.
 *
 * All variants of an item run back to back, so load on the machine falls on all of them alike. A
 * variant whose pairs and batching match one already run for the item takes its scores and time.
 * Per item, `rerank-inputs-<name>.jsonl` keeps each variant's time and how far padding moved the
 * scores, and the set's slices get how much of the read the turn path's query takes, for `score`.
 */
import {
  Array as Arr,
  Console,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Iterable,
  Option,
  Order,
  Schema,
} from "effect";
import { PairCut, paddedBatch, pairTokens } from "../../src/memory/rerank/pairs.ts";
import { rerankModel } from "../../src/memory/rerank/reranker.ts";
import { path } from "../../src/runtime/synchronous-path.ts";
import { appReranker } from "./app-reranker.ts";
import { appendRows, type Item, type Need, readRows, setFiles } from "./files.ts";
import { nodeRecords, statementsBefore } from "./nodes.ts";
import { alternate, keptIds } from "./pool.ts";
import { turnQuery } from "./turns.ts";

/** Which query the reranker reads. */
type QueryChoice = "item" | "turn" | "latest" | "each";
/** How pairs go to the model. */
type Batching = "padded" | "single" | "split";

interface Variant {
  readonly query: QueryChoice;
  readonly cut: PairCut;
  readonly batching: Batching;
}

const head = PairCut.cases.head.make({});
const longestFirst = PairCut.cases["longest-first"].make({});

/** The variants' names, the suffix of their runs' names. */
const VariantName = Schema.Literals([
  "head",
  "head-single",
  "item-head",
  "longest",
  "longest-single",
  "longest-split",
  "quarter-query",
  "latest-head",
  "latest-longest",
  "each-longest",
]);
type VariantName = typeof VariantName.Type;
const variantNames = VariantName.literals;

/** The variants. `head` is what the app runs now. */
const inputVariants = {
  head: { query: "turn", cut: head, batching: "padded" },
  "head-single": { query: "turn", cut: head, batching: "single" },
  "item-head": { query: "item", cut: head, batching: "padded" },
  longest: { query: "turn", cut: longestFirst, batching: "padded" },
  "longest-single": { query: "turn", cut: longestFirst, batching: "single" },
  "longest-split": { query: "turn", cut: longestFirst, batching: "split" },
  "quarter-query": {
    query: "turn",
    cut: PairCut.cases["query-share"].make({ share: 0.25 }),
    batching: "padded",
  },
  "latest-head": { query: "latest", cut: head, batching: "padded" },
  "latest-longest": { query: "latest", cut: longestFirst, batching: "padded" },
  "each-longest": { query: "each", cut: longestFirst, batching: "padded" },
} as const satisfies Record<VariantName, Variant>;

/** What one item's variants cost and how far padding moved their scores. */
const ItemCost = Schema.Struct({
  item: Schema.String,
  candidates: Schema.Finite,
  /** Tokens of the turn path's query, special tokens left out. */
  queryTokens: Schema.Finite,
  /** Each variant's time, building the pairs included. */
  ms: Schema.Record(Schema.String, Schema.Finite),
  /** The largest logit difference between the padded batch and each pair alone, per cut. */
  paddingGap: Schema.Struct({ head: Schema.Finite, longest: Schema.Finite }),
});

export interface RerankInputsOptions {
  readonly storage: string;
  /** The runs' name prefix. */
  readonly name: string;
  /** Ids taken from the top of each channel's run. */
  readonly depth: number;
}

/** One computation an item's variants may share: the time it took and its result. */
interface Timed<A> {
  readonly ms: number;
  readonly value: A;
}

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.timed(effect), ([took, value]): Timed<A> => ({
    ms: Duration.toMillis(took),
    value,
  }));

/** Indexes of the pairs in batches: all, each alone, or two by length with the least padding. */
const batchesOf = (pairs: ReadonlyArray<ReadonlyArray<number>>, batching: Batching) => {
  const indexes = Arr.makeBy(pairs.length, (index) => index);
  if (batching === "padded") return [indexes];
  if (batching === "single") return indexes.map((index) => [index]);
  const sorted = Arr.sort(
    indexes,
    Order.mapInput(Order.Number, (index: number) => pairs[index]!.length),
  );
  const width = (index: number) => pairs[sorted[index]!]!.length;
  // Splitting before `at` pads the first batch to the length at `at - 1`, the second to the last.
  const padded = (at: number) =>
    at * width(at - 1) + (sorted.length - at) * width(sorted.length - 1);
  const at = Arr.reduce(Arr.range(1, sorted.length), sorted.length, (best, each) =>
    padded(each) < padded(best) ? each : best,
  );
  return [sorted.slice(0, at), sorted.slice(at)].filter(Arr.isReadonlyArrayNonEmpty);
};

export const rerankInputs = Effect.fn("searchSet.rerankInputs")(function* ({
  storage,
  name,
  depth,
}: RerankInputsOptions) {
  const files = setFiles(storage);
  const runName = (variant: VariantName) => `${name}-${variant}`;
  const costFile = {
    schema: ItemCost,
    path: path.join(files.root, `rerank-inputs-${name}.jsonl`),
  };
  const done = HashSet.fromIterable(Iterable.map(yield* readRows(costFile), (row) => row.item));
  const channels = yield* Effect.forEach(["vector", "morph", "text"], (run) =>
    Effect.map(readRows(files.run(run)), (rows) =>
      HashMap.fromIterable(Iterable.map(rows, (row) => [row.item, row.ids] as const)),
    ),
  );
  const needs = HashMap.fromIterable(
    Iterable.map(yield* readRows(files.needs), (need) => [need.need, need] as const),
  );
  const items = (yield* readRows(files.items)).flatMap((item) =>
    HashSet.has(done, item.item)
      ? []
      : Option.toArray(HashMap.get(needs, item.need)).map((need) => ({ item, need })),
  );
  yield* Console.log(`items to rerank ${items.length}`);
  const reranker = yield* appReranker(storage);
  const tokenizer = reranker.tokenizer;
  const padId = tokenizer.pad_token_id;
  /** A cut's name, by which its pairs are shared between variants. */
  const cutName = PairCut.match({
    head: () => "head",
    "longest-first": () => "longest-first",
    "query-share": ({ share }) => `query-share ${share}`,
  });
  const builders = HashMap.fromIterable(
    Iterable.map(variantNames, (variant) => {
      const { cut } = inputVariants[variant];
      return [
        cutName(cut),
        pairTokens({ tokenizer, maxTokens: rerankModel.maxTokens, cut }),
      ] as const;
    }),
  );
  const room = rerankModel.maxTokens - tokenizer.encode("", { text_pair: "" }).length;
  // The first batch also compiles the device's kernels; it is not one an item would wait for.
  yield* reranker.run(
    paddedBatch({ pairs: [tokenizer.encode("준비", { text_pair: "준비" })], padId }),
  );

  /** Scores of the pairs, the same pairs scored once as the app does, in the variant's batches. */
  const scored = (pairs: ReadonlyArray<ReadonlyArray<number>>, batching: Batching) =>
    Effect.gen(function* () {
      const keys = pairs.map((pair) => pair.join(","));
      const distinct = Arr.dedupe(keys);
      const unique = distinct.map((key) => pairs[keys.indexOf(key)]!);
      const results = yield* Effect.forEach(batchesOf(unique, batching), (batch) =>
        Effect.map(
          reranker.run(paddedBatch({ pairs: batch.map((index) => unique[index]!), padId })),
          (scores) => batch.map((index, at) => [index, scores[at]!] as const),
        ),
      );
      const byIndex = HashMap.fromIterable(results.flat());
      return keys.map((key) =>
        Option.getOrElse(
          HashMap.get(byIndex, distinct.indexOf(key)),
          () => Number.NEGATIVE_INFINITY,
        ),
      );
    });

  const rerankItem = (item: Item, need: Need) =>
    Effect.gen(function* () {
      const candidates = Arr.dedupe(
        alternate(
          channels.map((run) =>
            Option.getOrElse(HashMap.get(run, item.item), () => []).slice(0, depth),
          ),
        ),
      );
      const nodes = yield* nodeRecords(candidates);
      const statements =
        need.kind === "recall" && need.beforeSeq !== null
          ? (yield* statementsBefore(need.beforeSeq)).filter((text) => text.length > 0)
          : [];
      const queries: Record<QueryChoice, ReadonlyArray<string>> = Arr.isReadonlyArrayNonEmpty(
        statements,
      )
        ? {
            item: [item.query],
            turn: [turnQuery(statements)],
            latest: [Arr.lastNonEmpty(statements)],
            each: Arr.dedupe(statements),
          }
        : { item: [item.query], turn: [item.query], latest: [item.query], each: [item.query] };
      const texts = nodes.map((node) => node.text);

      // Each (cut, query) is built once and each (batching, pairs) scored once for the item, all
      // back to back; a variant adds up the time of the parts it uses.
      const uses = variantNames.flatMap((variant) => {
        const { query, cut, batching } = inputVariants[variant];
        return queries[query].map((text) => ({
          variant,
          batching,
          cut: cutName(cut),
          pairKey: `${cutName(cut)}\u0000${text}`,
          text,
        }));
      });
      const built = HashMap.fromIterable(
        yield* Effect.forEach(
          Arr.dedupeWith(uses, (a, b) => a.pairKey === b.pairKey),
          (use) =>
            Effect.map(
              timed(
                Effect.sync(() =>
                  Option.getOrThrow(HashMap.get(builders, use.cut))(use.text, texts),
                ),
              ),
              (pairs) => [use.pairKey, pairs] as const,
            ),
        ),
      );
      const pairsOf = (pairKey: string) => Option.getOrThrow(HashMap.get(built, pairKey));
      const scoreKey = (use: (typeof uses)[number]) =>
        `${use.batching}\u0000${pairsOf(use.pairKey)
          .value.map((pair) => pair.join(","))
          .join(";")}`;
      const scores = HashMap.fromIterable(
        yield* Effect.forEach(
          Arr.dedupeWith(uses, (a, b) => scoreKey(a) === scoreKey(b)),
          (use) =>
            Effect.map(
              timed(scored(pairsOf(use.pairKey).value, use.batching)),
              (result) => [scoreKey(use), result] as const,
            ),
        ),
      );
      const results = HashMap.fromIterable(
        Iterable.map(variantNames, (variant) => {
          const parts = uses
            .filter((use) => use.variant === variant)
            .map((use) => ({
              built: pairsOf(use.pairKey),
              scored: Option.getOrThrow(HashMap.get(scores, scoreKey(use))),
            }));
          return [
            variant,
            {
              ms: parts.reduce((sum, part) => sum + part.built.ms + part.scored.ms, 0),
              // Each statement on its own: a text keeps its best score.
              value: texts.map((_, index) =>
                Math.max(
                  ...parts.map((part) => part.scored.value[index] ?? Number.NEGATIVE_INFINITY),
                ),
              ),
            },
          ] as const;
        }),
      );
      const scoresOf = (variant: VariantName) =>
        Option.getOrThrow(HashMap.get(results, variant)).value;
      const gap = (padded: VariantName, single: VariantName) =>
        Math.max(
          0,
          ...scoresOf(padded).map((score, index) => Math.abs(score - scoresOf(single)[index]!)),
        );
      yield* Effect.forEach(
        variantNames,
        (variant) =>
          appendRows(files.run(runName(variant)))([
            {
              item: item.item,
              ids: Arr.sort(
                nodes.map((node, index) => ({ id: node.id, score: scoresOf(variant)[index]! })),
                Order.mapInput(Order.flip(Order.Number), (each: { score: number }) => each.score),
              )
                .map(({ id }) => id)
                .slice(0, keptIds),
            },
          ]),
        { discard: true },
      );
      const queryTokens = tokenizer.encode(queries.turn[0]!, {
        add_special_tokens: false,
      }).length;
      yield* appendRows(files.slices)([
        {
          item: item.item,
          slice:
            queryTokens <= Math.floor(room / 2)
              ? "query within half the read"
              : queryTokens < room
                ? "query over half the read"
                : "query fills the read",
        },
      ]);
      const row = {
        item: item.item,
        candidates: nodes.length,
        queryTokens,
        ms: Object.fromEntries(
          variantNames.map((variant) => [
            variant,
            Option.getOrThrow(HashMap.get(results, variant)).ms,
          ]),
        ),
        paddingGap: {
          head: Arr.isReadonlyArrayNonEmpty(nodes) ? gap("head", "head-single") : 0,
          longest: Arr.isReadonlyArrayNonEmpty(nodes) ? gap("longest", "longest-single") : 0,
        },
      };
      yield* appendRows(costFile)([row]);
      return row;
    });

  const rows = yield* Effect.forEach(items, ({ item, need }) => rerankItem(item, need));
  const percentile = (share: number) => (values: ReadonlyArray<number>) => {
    const sorted = Arr.sort(values, Order.Number);
    return sorted[Math.round((sorted.length - 1) * share)] ?? 0;
  };
  const measured = rows.filter((row) => row.candidates > 0);
  yield* Console.log("| variant | p50 ms | p95 ms | max ms | mean ms |\n|---|---|---|---|---|");
  yield* Effect.forEach(
    variantNames,
    (variant) => {
      const ms = measured.map((row) => row.ms[variant] ?? 0);
      return Console.log(
        `| ${variant} | ${percentile(0.5)(ms).toFixed(0)} | ${percentile(0.95)(ms).toFixed(0)} | ${percentile(1)(ms).toFixed(0)} | ${(ms.reduce((sum, each) => sum + each, 0) / Math.max(1, ms.length)).toFixed(0)} |`,
      );
    },
    { discard: true },
  );
  yield* Console.log(
    `padding gap (max logit change per item) head p50 ${percentile(0.5)(measured.map((row) => row.paddingGap.head)).toFixed(3)} max ${percentile(1)(measured.map((row) => row.paddingGap.head)).toFixed(3)}; longest p50 ${percentile(0.5)(measured.map((row) => row.paddingGap.longest)).toFixed(3)} max ${percentile(1)(measured.map((row) => row.paddingGap.longest)).toFixed(3)}`,
  );
}, Effect.scoped);
