/**
 * Grades the pooled results of every need with the model: the top `depth` ids of each item of the
 * need in each run, and the need's known nodes. Pairs already graded are not asked again, so a new
 * search system's run only costs the nodes no earlier system returned. A second model can grade a
 * share of the same pairs into its own file, and `agreement` compares the two.
 */
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  HashMap,
  HashSet,
  Option,
  Schema,
} from "effect";
import { sha256 } from "../../src/runtime/synchronous-crypto.ts";
import {
  appendRows,
  Grade,
  type Judgment,
  type Need,
  readRows,
  type RowFile,
  setFiles,
} from "./files.ts";
import { answerObject, EvalModel } from "./model.ts";
import { type NodeRecord, nodeRecords } from "./nodes.ts";

/** Records per model call. */
const batchSize = 10;
/** A record longer than this is cut; most records say what they are about early. */
const recordCharacters = 1_200;

const Grades = Schema.Struct({
  grades: Schema.Array(Schema.Struct({ n: Schema.Finite, grade: Grade })),
});

const instructions = `You grade the results of a memory search over a person's past conversations with a coding agent.

You get what was being looked for and numbered records from the past conversations. Grade each record on its own:
2 = it holds what is being looked for: the answer, the decision, the fact or the result itself.
1 = it is about the same specific matter and helps, but does not hold the answer itself.
0 = anything else, including records that only share a general topic or a few words.

Judge by the record's text only; a record may be cut short.
Answer with JSON only: {"grades": [{"n": 1, "grade": 0}, ...]} with one entry per record.`;

/** How the judge is told what was looked for, by the kind of need. */
const needFraming = {
  find: (description: string) =>
    `An agent searched its memory while working in a conversation.\n${description}`,
  recall: (description: string) =>
    `The user just wrote the messages below, latest last. Records that help the agent reply hold earlier decisions, facts or work these messages refer to or build on.\n\nMessages:\n${description}`,
  round: (description: string) => `Question: ${description}`,
} satisfies { readonly [Kind in Need["kind"]]: (description: string) => string };

const needText = (need: Need) => needFraming[need.kind](need.description);

const recordText = (record: NodeRecord, n: number) =>
  `[${n}] ${record.kind}, ${record.created_at.slice(0, 10)}\n${
    record.text.length > recordCharacters
      ? `${record.text.slice(0, recordCharacters)}…`
      : record.text
  }`;

const pairKey = (need: string, node: string) => `${need}\u0000${node}`;

/** One need and the records of it still to grade. */
interface Work {
  readonly need: Need;
  readonly records: ReadonlyArray<NodeRecord>;
}

/** Grades the work's records in batches and appends the grades to `file` as each batch settles. */
const gradeBatches = Effect.fn("searchSet.gradeBatches")(function* (
  file: RowFile<typeof Judgment>,
  work: ReadonlyArray<Work>,
  concurrency: number,
) {
  const model = yield* EvalModel;
  const batches = work.flatMap(({ need, records }) =>
    Arr.chunksOf(records, batchSize).map((batch) => ({ need, batch })),
  );
  yield* Console.log(
    `needs ${work.length}; records ${work.reduce((sum, { records }) => sum + records.length, 0)}; calls ${batches.length}`,
  );
  const graded = yield* Effect.forEach(
    batches,
    ({ need, batch }) =>
      model
        .ask(
          instructions,
          `${needText(need)}\n\nRecords:\n\n${batch.map((record, index) => recordText(record, index + 1)).join("\n\n")}`,
        )
        .pipe(
          Effect.map((answer) => {
            const grades = HashMap.fromIterable(
              Option.match(Option.flatMap(answer, answerObject(Grades)), {
                onNone: () => [],
                onSome: ({ grades }) => grades.map(({ n, grade }) => [n, grade] as const),
              }),
            );
            return batch.flatMap((record, index) =>
              Option.toArray(HashMap.get(grades, index + 1)).map((grade): Judgment => ({
                need: need.need,
                node: record.id,
                grade,
                judge: model.name,
              })),
            );
          }),
          Effect.tap(appendRows(file)),
          Effect.map((judgments) => judgments.length),
        ),
    { concurrency },
  );
  const total = batches.reduce((sum, { batch }) => sum + batch.length, 0);
  const done = graded.reduce((sum, count) => sum + count, 0);
  yield* Console.log(`graded ${done} of ${total}; left for a later run ${total - done}`);
});

export interface JudgeInput {
  readonly storage: string;
  /** Runs to pool; none pools every run. */
  readonly runs: ReadonlyArray<string>;
  readonly depth: number;
  readonly concurrency: number;
}

/**
 * Grades every pooled pair not graded yet: the top `depth` ids of the named runs (all runs when none
 * are named) for each item, and each need's known nodes.
 */
export const judgePools = Effect.fn("searchSet.judge")(function* ({
  storage,
  runs,
  depth,
  concurrency,
}: JudgeInput) {
  const fs = yield* FileSystem.FileSystem;
  const files = setFiles(storage);
  const names = Arr.isReadonlyArrayNonEmpty(runs)
    ? runs
    : (yield* fs.readDirectory(files.runs))
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => file.slice(0, -".jsonl".length));
  const needOf = HashMap.fromIterable(
    (yield* readRows(files.items)).map((item) => [item.item, item.need] as const),
  );
  const ranked = (yield* Effect.forEach(names, (name) => readRows(files.run(name)))).flat();
  const pooled = Arr.groupBy(
    ranked.flatMap((row) =>
      Option.toArray(HashMap.get(needOf, row.item)).flatMap((need) =>
        row.ids.slice(0, depth).map((node) => ({ need, node })),
      ),
    ),
    ({ need }) => need,
  );
  const judged = HashSet.fromIterable(
    (yield* readRows(files.judgments)).map(({ need, node }) => pairKey(need, node)),
  );
  const work = yield* Effect.forEach(yield* readRows(files.needs), (need) =>
    Effect.map(
      nodeRecords(
        Arr.dedupe([...need.known, ...(pooled[need.need] ?? []).map(({ node }) => node)]).filter(
          (node) => !HashSet.has(judged, pairKey(need.need, node)),
        ),
      ),
      (records): Work => ({ need, records }),
    ),
  );
  yield* Console.log(`runs ${names.join(", ")}; depth ${depth}`);
  yield* gradeBatches(
    files.judgments,
    work.filter(({ records }) => records.length > 0),
    concurrency,
  );
});

/** Whether a need falls in the checked share: a fixed hash order, so reruns check the same needs. */
const inShare = (need: string, share: number) =>
  Number.parseInt(sha256(need).slice(0, 8), 16) / 0x1_0000_0000 < share;

export interface CheckInput {
  readonly storage: string;
  /** The share of needs, 0 to 1, whose graded pairs the second model grades. */
  readonly share: number;
  readonly concurrency: number;
}

/** Grades with a second model the pairs the main judge graded, for a `share` of the needs. */
export const judgeCheck = Effect.fn("searchSet.judgeCheck")(function* ({
  storage,
  share,
  concurrency,
}: CheckInput) {
  const model = yield* EvalModel;
  const files = setFiles(storage);
  const file = files.check(model.name);
  const checked = HashSet.fromIterable(
    (yield* readRows(file)).map(({ need, node }) => pairKey(need, node)),
  );
  const pending = Arr.groupBy(
    (yield* readRows(files.judgments)).filter(
      ({ need, node }) => inShare(need, share) && !HashSet.has(checked, pairKey(need, node)),
    ),
    ({ need }) => need,
  );
  const work = yield* Effect.forEach(
    (yield* readRows(files.needs)).filter((need) => Object.hasOwn(pending, need.need)),
    (need) =>
      Effect.map(nodeRecords(pending[need.need]!.map(({ node }) => node)), (records): Work => ({
        need,
        records,
      })),
  );
  yield* gradeBatches(file, work, concurrency);
});

export interface AgreementInput {
  readonly storage: string;
  /** The second model's name as its grades record it: provider/model. */
  readonly model: string;
}

/**
 * How well the second model's grades agree with the main judge's: exact agreement, agreement on
 * relevant (grade 1 or 2) or not, and Cohen's kappa with quadratic weights over the three grades.
 */
export const agreement = Effect.fn("searchSet.agreement")(function* ({
  storage,
  model,
}: AgreementInput) {
  const files = setFiles(storage);
  const main = HashMap.fromIterable(
    (yield* readRows(files.judgments)).map((row) => [pairKey(row.need, row.node), row.grade]),
  );
  const pairs = (yield* readRows(files.check(model))).flatMap((row) =>
    Option.toArray(HashMap.get(main, pairKey(row.need, row.node))).map(
      (first) => [first, row.grade] as const,
    ),
  );
  const n = Math.max(1, pairs.length);
  const grades = [0, 1, 2] as const;
  const share = (grade: Grade, side: 0 | 1) =>
    pairs.filter((pair) => pair[side] === grade).length / n;
  const weight = (a: number, b: number) => ((a - b) / 2) ** 2;
  const observed = pairs.reduce((sum, [a, b]) => sum + weight(a, b), 0) / n;
  const expected = grades
    .flatMap((a) => grades.map((b) => weight(a, b) * share(a, 0) * share(b, 1)))
    .reduce((sum, value) => sum + value, 0);
  const exact = pairs.filter(([a, b]) => a === b).length / n;
  const binary = pairs.filter(([a, b]) => a > 0 === b > 0).length / n;
  yield* Console.log(
    `pairs ${pairs.length}; exact ${exact.toFixed(3)}; relevant-or-not ${binary.toFixed(3)}; ` +
      `weighted kappa ${(expected === 0 ? 1 : 1 - observed / expected).toFixed(3)}; ` +
      `main grades ${grades.map((g) => share(g, 0).toFixed(2)).join("/")}; ` +
      `check grades ${grades.map((g) => share(g, 1).toFixed(2)).join("/")}`,
  );
});
