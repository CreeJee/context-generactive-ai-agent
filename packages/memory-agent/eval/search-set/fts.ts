/**
 * The native read's SQLite FTS5 statements as runs of their own, `fts-trigram` and `fts-morph`, with
 * the terms the app sends (query-terms.jsonl). They run on node's SQLite, the one the native read is
 * loaded into in the app, with the read's cache and mmap settings. Search engines benchmarked outside
 * the app (tools/tantivy-bench) are compared with these runs and times. Each item reads its own
 * project, then the other projects it may read, and only nodes stored before a recorded question.
 */
import { Array as Arr, Console, Duration, Effect, HashMap, Option, Order, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { appendRows, type QueryTerms, readRows, type RunRow, setFiles } from "./files.ts";
import { alternate, channelDepth, keptIds } from "./pool.ts";

/** The native read's text stage budget: the 2 s read less the 600 ms it keeps for the rest. */
const textBudgetMs = 1_400;
const readBudgetMs = 2_000;

const RunName = Schema.Literals(["fts-trigram", "fts-morph"]);
type RunName = typeof RunName.Type;
const runNames = RunName.literals;

/** The runs and the statements behind them, as packages/turbovec/src/read_session.rs runs them. */
const statements = {
  "fts-trigram": { table: "nodes_fts", terms: (terms: QueryTerms) => terms.trigram },
  "fts-morph": { table: "nodes_morph", terms: (terms: QueryTerms) => terms.morph },
} satisfies Record<
  RunName,
  { readonly table: string; readonly terms: (terms: QueryTerms) => ReadonlyArray<string> }
>;

/** The FTS5 query the native read sends: every term quoted, any of them matching. */
const quoted = (terms: ReadonlyArray<string>) =>
  terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");

const RankRequest = Schema.Struct({
  run: RunName,
  matching: Schema.String,
  projects: Schema.Array(Schema.String),
  beforeSeq: Schema.NullOr(Schema.Finite),
});

/** One item's search in one run: its row, and how long the statements took when they ran. */
interface Searched {
  readonly run: RunName;
  readonly row: RunRow;
  readonly ms: Option.Option<number>;
}

const percentile = (sorted: ReadonlyArray<number>, share: number) =>
  sorted[Math.round((sorted.length - 1) * share)] ?? 0;

export const ftsRuns = Effect.fn("searchSet.fts")(function* (storage: string) {
  const sql = yield* SqlClient.SqlClient;
  const files = setFiles(storage);
  // The native read's connection settings (read_session.rs): a 256 MB page cache and 1 GB of mmap.
  yield* Effect.all([sql`PRAGMA cache_size=-262144`, sql`PRAGMA mmap_size=1073741824`], {
    discard: true,
  });

  const ranked = SqlSchema.findAll({
    Request: RankRequest,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ run, matching, projects, beforeSeq }) => {
      const table = sql.literal(statements[run].table);
      return sql`
        SELECT n.id FROM ${table} f JOIN nodes n ON n.seq = f.rowid
        WHERE NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)
          AND ${table} MATCH ${matching} AND n.project_id IN ${sql.in(projects)}
          ${
            // On the FTS rowid, not n.seq: for one project SQLite would walk nodes_project(project_id,
            // seq) and test the MATCH row by row, tens of seconds where the app's statement takes ms.
            beforeSeq === null ? sql.literal("") : sql`AND f.rowid < ${beforeSeq}`
          }
        ORDER BY f.rank LIMIT ${channelDepth}`;
    },
  });
  const otherProjects = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: (projectId) =>
      sql`SELECT id FROM projects WHERE cross_recall_excluded = 0 AND id != ${projectId}`,
  });

  const done = yield* Effect.forEach(runNames, (run) =>
    Effect.map(readRows(files.run(run)), (rows) => new Set(rows.map((row) => row.item))),
  );
  const needs = HashMap.fromIterable(
    (yield* readRows(files.needs)).map((need) => [need.need, need] as const),
  );
  const terms = HashMap.fromIterable(
    (yield* readRows(files.terms)).map((row) => [row.item, row] as const),
  );
  const items = (yield* readRows(files.items)).flatMap((item) =>
    done.every((items) => items.has(item.item))
      ? []
      : Option.toArray(
          Option.all({ need: HashMap.get(needs, item.need), terms: HashMap.get(terms, item.item) }),
        ).map(({ need, terms }) => ({ item: item.item, need, terms })),
  );
  yield* Console.log(`items to search ${items.length}`);

  const searched = yield* Effect.forEach(items, ({ item, need, terms }) =>
    Effect.gen(function* () {
      const scopes = [
        [need.projectId],
        ...(need.crossProject ? [(yield* otherProjects(need.projectId)).map(({ id }) => id)] : []),
      ].filter(Arr.isReadonlyArrayNonEmpty);
      return yield* Effect.forEach(runNames, (run): Effect.Effect<Searched, Schema.SchemaError> => {
        const listed = statements[run].terms(terms);
        const search = Effect.forEach(scopes, (projects) =>
          ranked({ run, matching: quoted(listed), projects, beforeSeq: need.beforeSeq }),
        ).pipe(
          Effect.timed,
          Effect.map(([took, lists]): Searched => ({
            run,
            row: {
              item,
              ids: alternate(lists.map((rows) => rows.map(({ id }) => id))).slice(0, keptIds),
            },
            ms: Option.some(Duration.toMillis(took)),
          })),
          // FTS5 rejects some queries; the item then has no row ids, as the read would fail.
          Effect.catchTag("SqlError", (error) =>
            Effect.succeed<Searched>({
              run,
              row: { item, ids: [], failed: error.message },
              ms: Option.none(),
            }),
          ),
        );
        return Arr.isReadonlyArrayNonEmpty(listed)
          ? search
          : Effect.succeed<Searched>({ run, row: { item, ids: [] }, ms: Option.none() });
      }).pipe(
        Effect.tap((results) =>
          Effect.forEach(results, ({ run, row }) => appendRows(files.run(run))([row]), {
            discard: true,
          }),
        ),
      );
    }),
  );

  yield* Effect.forEach(
    runNames,
    (run) => {
      const results = searched.flat().filter((result) => result.run === run);
      const ms = Arr.sort(Arr.getSomes(results.map((result) => result.ms)), Order.Number);
      const over = (limit: number) => ms.filter((each) => each > limit).length;
      const mean = ms.reduce((sum, each) => sum + each, 0) / Math.max(1, ms.length);
      return Console.log(
        `${run}: timed ${ms.length}; p50 ${percentile(ms, 0.5).toFixed(1)} ms; ` +
          `p95 ${percentile(ms, 0.95).toFixed(1)} ms; max ${percentile(ms, 1).toFixed(1)} ms; ` +
          `mean ${mean.toFixed(1)} ms; over ${textBudgetMs} ms ${over(textBudgetMs)}; ` +
          `over ${readBudgetMs} ms ${over(readBudgetMs)}; ` +
          `failed ${results.filter((result) => result.row.failed !== undefined).length}`,
      );
    },
    { discard: true },
  );
});
