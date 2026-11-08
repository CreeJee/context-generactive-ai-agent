/**
 * Scores runs against the judged set and prints only numbers. Per item, against its need's grades:
 * nDCG@10 (gain 2^grade - 1), Recall@20 and MRR over nodes graded 1 or 2, Ans@10 (a node graded 2 in
 * the top 10), and judged@10, the share of the top 10 the judge has graded: an ungraded node counts
 * as not relevant, so a low judged@10 means the run's scores are a lower bound until `judge` grades
 * that run. Items whose need has no relevant node are left out and counted. With more than one run,
 * the first is the baseline and each other run's nDCG@10 wins and losses against it are counted per
 * item. With `complete`, only items whose top 10 every scored run has graded are counted: until the
 * judge has graded every run, an ungraded node would count against one run more than another.
 */
import { Array as Arr, Console, Effect, HashMap, Option, Order } from "effect";
import { ageBandOf, type Item, type Need, readRows, type RunRow, setFiles } from "./files.ts";

interface ItemScore {
  readonly item: string;
  readonly slices: ReadonlyArray<string>;
  readonly failed: boolean;
  readonly ndcg: number;
  readonly recall: number;
  readonly reciprocal: number;
  readonly answer: number;
  readonly judged: number;
  /** Every node of the top 10 is graded. */
  readonly complete: boolean;
}

const dcg = (gains: ReadonlyArray<number>) =>
  gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
const gainOf = (grade: number) => 2 ** grade - 1;

/** The slices an item is counted in, besides "all". */
const slicesOf = (item: Item, need: Need) => [
  `style ${item.style}`,
  `language ${item.language}`,
  `exact ${item.exact ? "yes" : "no"}`,
  ...Option.toArray(Option.fromNullishOr(need.ageDays)).map((days) => `age ${ageBandOf(days)}`),
];

const scoreItem = (
  item: Item,
  need: Need,
  grades: HashMap.HashMap<string, number>,
  row: RunRow,
): ItemScore => {
  const gradeAt = (id: string) => Option.getOrElse(HashMap.get(grades, id), () => 0);
  const values = [...HashMap.values(grades)];
  const relevant = Arr.countBy(values, (grade) => grade > 0);
  const ideal = dcg(Arr.sort(values, Order.flip(Order.Number)).slice(0, 10).map(gainOf));
  const top10 = row.ids.slice(0, 10);
  const top20 = row.ids.slice(0, 20);
  const first = top20.findIndex((id) => gradeAt(id) > 0);
  return {
    item: item.item,
    slices: slicesOf(item, need),
    failed: row.failed !== undefined,
    ndcg: ideal === 0 ? 0 : dcg(top10.map((id) => gainOf(gradeAt(id)))) / ideal,
    recall: Arr.countBy(top20, (id) => gradeAt(id) > 0) / Math.max(1, relevant),
    reciprocal: first < 0 ? 0 : 1 / (first + 1),
    answer: top10.some((id) => gradeAt(id) === 2) ? 1 : 0,
    judged: Arr.countBy(top10, (id) => HashMap.has(grades, id)) / Math.max(1, top10.length),
    complete: top10.every((id) => HashMap.has(grades, id)),
  };
};

const mean = (values: ReadonlyArray<number>) =>
  (values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3);

export interface ScoreInput {
  readonly storage: string;
  /** Runs to score; the first is the baseline. */
  readonly runs: ReadonlyArray<string>;
  /** Only items whose top 10 every run has graded. */
  readonly complete: boolean;
}

export const scoreRuns = Effect.fn("searchSet.score")(function* ({
  storage,
  runs,
  complete,
}: ScoreInput) {
  const files = setFiles(storage);
  const needs = HashMap.fromIterable(
    (yield* readRows(files.needs)).map((need) => [need.need, need] as const),
  );
  const gradesOf = HashMap.fromIterable(
    Object.entries(Arr.groupBy(yield* readRows(files.judgments), ({ need }) => need)).map(
      ([need, rows]) =>
        [
          need,
          HashMap.fromIterable(rows.map((row): readonly [string, number] => [row.node, row.grade])),
        ] as const,
    ),
  );
  const items = (yield* readRows(files.items)).flatMap((item) =>
    Option.toArray(HashMap.get(needs, item.need)).map((need) => ({ item, need })),
  );
  const scorable = items.flatMap(({ item, need }) =>
    Option.toArray(
      Option.filter(HashMap.get(gradesOf, need.need), (grades) =>
        [...HashMap.values(grades)].some((grade) => grade > 0),
      ),
    ).map((grades) => ({ item, need, grades })),
  );
  yield* Console.log(
    `items ${items.length}; with a relevant node ${scorable.length}; judgments ${[...HashMap.values(gradesOf)].reduce((sum, grades) => sum + HashMap.size(grades), 0)}`,
  );
  const all = yield* Effect.forEach(runs, (run) =>
    Effect.map(readRows(files.run(run)), (rows) => {
      // A resumed run may hold an item twice; the last row is the one written last.
      const rowOf = HashMap.fromIterable(rows.map((row) => [row.item, row] as const));
      return {
        run,
        scores: scorable.flatMap(({ item, need, grades }) =>
          Option.toArray(HashMap.get(rowOf, item.item)).map((row) =>
            scoreItem(item, need, grades, row),
          ),
        ),
      };
    }),
  );
  const completeIn = all.map(({ scores }) =>
    HashMap.fromIterable(scores.map((score) => [score.item, score.complete] as const)),
  );
  const counted = (score: ItemScore) =>
    !complete ||
    completeIn.every((run) => Option.getOrElse(HashMap.get(run, score.item), () => false));
  const scored = all.map(({ run, scores }) => ({ run, scores: scores.filter(counted) }));
  yield* Effect.when(
    Console.log(
      `complete in every run: ${Arr.head(scored).pipe(Option.match({ onNone: () => 0, onSome: ({ scores }) => scores.length }))} items`,
    ),
    Effect.succeed(complete),
  );
  const slices = [
    "all",
    ...Arr.sort(
      Arr.dedupe(scored.flatMap(({ scores }) => scores.flatMap((score) => score.slices))),
      Order.String,
    ),
  ];
  yield* Console.log(
    "| slice | run | n | failed | nDCG@10 | R@20 | MRR | Ans@10 | judged@10 |\n|---|---|---|---|---|---|---|---|---|",
  );
  yield* Effect.forEach(
    slices.flatMap((slice) =>
      scored.map(({ run, scores }) => ({
        slice,
        run,
        selected: scores.filter((score) => slice === "all" || score.slices.includes(slice)),
      })),
    ),
    ({ slice, run, selected }) =>
      Console.log(
        `| ${slice} | ${run} | ${selected.length} | ${Arr.countBy(selected, (score) => score.failed)} | ${mean(selected.map((score) => score.ndcg))} | ${mean(selected.map((score) => score.recall))} | ${mean(selected.map((score) => score.reciprocal))} | ${mean(selected.map((score) => score.answer))} | ${mean(selected.map((score) => score.judged))} |`,
      ),
    { discard: true },
  );
  yield* Option.match(Arr.head(scored), {
    onNone: () => Effect.void,
    onSome: (baseline) => {
      const baseOf = HashMap.fromIterable(
        baseline.scores.map((score) => [score.item, score.ndcg] as const),
      );
      return Effect.forEach(
        scored.slice(1),
        ({ run, scores }) => {
          const changes = scores.flatMap((score) =>
            Option.toArray(HashMap.get(baseOf, score.item)).map((base) => score.ndcg - base),
          );
          return Console.log(
            `${run} vs ${baseline.run}: nDCG@10 wins ${Arr.countBy(changes, (d) => d > 1e-9)}, losses ${Arr.countBy(changes, (d) => d < -1e-9)}, ties ${Arr.countBy(changes, (d) => Math.abs(d) <= 1e-9)}; mean change ${mean(changes)}`,
          );
        },
        { discard: true },
      );
    },
  });
});
