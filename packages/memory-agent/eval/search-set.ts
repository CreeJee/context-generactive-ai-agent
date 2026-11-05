/**
 * The memory search evaluation set: needs from recorded searches and from past rounds, pooled
 * results of several search systems, and grades from a model judge. It replaces "the nodes the
 * model opened" as the only relevance signal, which rewarded returning what the search returned
 * then. Everything that holds memory text stays in <copy>/search-set; this prints counts and scores.
 *
 *   node --no-warnings eval/search-set.ts <command> <copy> …   (--help lists the commands)
 *
 * <copy> is a copy of a storage folder (agent.db, vectors/, models/), such as
 * node_modules/.vp-tmp/cga-bench made by the bench-copy-stage skill. The usual order: recorded,
 * rounds, pool, judge, then score; a new search system writes a run, judge grades what only it
 * returned, and score compares it with the others.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { StorageRoot } from "../src/config/storage-root.ts";
import { MorphAnalyzer } from "../src/memory/morph/analyzer.ts";
import { searchTuning, type SearchTuning } from "../src/memory/search.ts";
import { copyDatabase, copyLayer } from "./copy-storage.ts";
import { ftsRuns } from "./search-set/fts.ts";
import { agreement, judgeCheck, judgePools } from "./search-set/judge.ts";
import { EvalModel } from "./search-set/model.ts";
import { searchRuns } from "./search-set/pool.ts";
import { buildRecorded } from "./search-set/recorded.ts";
import { writeRounds } from "./search-set/rounds.ts";
import { scoreRuns } from "./search-set/score.ts";
import { writeTerms } from "./search-set/terms.ts";

const copy = Argument.Directory("copy", { mustExist: true }).pipe(
  Argument.withDescription("a copy of a storage folder: agent.db, vectors/, models/"),
);
const model = Flag.String("model").pipe(
  Flag.withDescription("another model of the selected provider, by id"),
  Flag.optional,
);
const concurrency = Flag.Int("concurrency").pipe(
  Flag.withDescription("model calls at once"),
  Flag.withDefault(2),
);
const TuningOverride = Schema.Struct({
  vectorCut: Schema.optional(Schema.Finite),
  vectorWeight: Schema.optional(Schema.Finite),
  textWeight: Schema.optional(Schema.Finite),
  morphWeight: Schema.optional(Schema.Finite),
  exactTextWeight: Schema.optional(Schema.Finite),
  otherProjectMerge: Schema.optional(Schema.Literals(["alternate", "append"])),
});
/** The app's tuning with the fields the flag names replaced. */
const tuning = Flag.String("tuning").pipe(
  Flag.withDescription("JSON of search tuning fields to replace"),
  Flag.withSchema(Schema.fromJsonString(TuningOverride)),
  Flag.map((override): SearchTuning => ({
    ...searchTuning,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
  })),
  Flag.optional,
);

/** The model, for the steps that ask it, beside the copy's database read-only. */
const withModel = (storage: string, model: Option.Option<string>) =>
  Layer.merge(copyDatabase(storage), EvalModel.layer({ storage, model }));

const recorded = Command.make("recorded", { copy }, ({ copy }) => buildRecorded(copy)).pipe(
  Command.withDescription("needs and items from recorded find_memory calls"),
  Command.provide(({ copy }) => copyDatabase(copy)),
);

const rounds = Command.make(
  "rounds",
  {
    copy,
    model,
    concurrency,
    count: Flag.Int("count").pipe(
      Flag.withDescription("rounds in all, counting those already written or skipped"),
      Flag.withDefault(160),
    ),
  },
  ({ copy, count, concurrency }) => writeRounds({ storage: copy, count, concurrency }),
).pipe(
  Command.withDescription("needs the model writes from past rounds, drawn across age and language"),
  Command.provide(({ copy, model }) => withModel(copy, model)),
);

const pool = Command.make("pool", { copy }, ({ copy }) =>
  searchRuns({ storage: copy, app: Option.some("app"), channels: true }),
).pipe(
  Command.withDescription("the app search and the native read's vector, text and morph lists"),
  Command.provide(({ copy }) => copyLayer({ storage: copy, tuning: Option.none() })),
);

const appRun = Command.make(
  "app-run",
  { copy, tuning, name: Flag.String("name").pipe(Flag.withDescription("the run's name")) },
  ({ copy, name }) => searchRuns({ storage: copy, app: Option.some(name), channels: false }),
).pipe(
  Command.withDescription("the app search alone, with a tuning override, as another run"),
  Command.provide(({ copy, tuning }) => copyLayer({ storage: copy, tuning })),
);

const terms = Command.make("terms", { copy }, ({ copy }) => writeTerms(copy)).pipe(
  Command.withDescription("every item's search terms, for engines benchmarked outside the app"),
  Command.provide(({ copy }) => MorphAnalyzer.kiwi.pipe(Layer.provide(StorageRoot.layer(copy)))),
);

const fts = Command.make("fts", { copy }, ({ copy }) => ftsRuns(copy)).pipe(
  Command.withDescription("the native read's FTS5 statements as runs, timed on the app's SQLite"),
  Command.provide(({ copy }) => copyDatabase(copy)),
);

const judge = Command.make(
  "judge",
  {
    copy,
    model,
    concurrency,
    runs: Argument.String("run").pipe(
      Argument.withDescription("runs to pool; none pools every run"),
      Argument.variadic(),
    ),
    depth: Flag.Int("depth").pipe(
      Flag.withDescription("ids pooled per item and run"),
      Flag.withDefault(20),
    ),
  },
  ({ copy, runs, depth, concurrency }) => judgePools({ storage: copy, runs, depth, concurrency }),
).pipe(
  Command.withDescription("grades the pooled pairs not graded yet"),
  Command.provide(({ copy, model }) => withModel(copy, model)),
);

const check = Command.make(
  "judge-check",
  {
    copy,
    model,
    concurrency,
    share: Flag.Finite("share").pipe(
      Flag.withDescription("the share of needs to grade again, 0 to 1"),
      Flag.withDefault(0.1),
    ),
  },
  ({ copy, share, concurrency }) => judgeCheck({ storage: copy, share, concurrency }),
).pipe(
  Command.withDescription("a second model grades a share of the graded pairs"),
  Command.provide(({ copy, model }) => withModel(copy, model)),
);

const agree = Command.make(
  "agreement",
  {
    copy,
    model: Flag.String("model").pipe(
      Flag.withDescription("the second model as its grades name it: provider/model"),
    ),
  },
  ({ copy, model }) => agreement({ storage: copy, model }),
).pipe(Command.withDescription("how the second model's grades agree with the main judge's"));

const score = Command.make(
  "score",
  {
    copy,
    runs: Argument.String("run").pipe(
      Argument.withDescription("runs to score; the first is the baseline"),
      Argument.variadic({ min: 1 }),
    ),
  },
  ({ copy, runs }) => scoreRuns({ storage: copy, runs }),
).pipe(Command.withDescription("the runs' scores, by slice"));

const searchSet = Command.make("search-set").pipe(
  Command.withDescription("the memory search evaluation set"),
  Command.withSubcommands([recorded, rounds, pool, appRun, terms, fts, judge, check, agree, score]),
);

Command.run(searchSet, { version: "1.0.0" }).pipe(
  // The script's entry point: the one place its platform services are provided.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
