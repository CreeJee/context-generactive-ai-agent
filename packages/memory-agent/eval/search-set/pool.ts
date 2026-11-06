/**
 * Search runs over the copy for every item. `app` is MemorySearch.find as the app runs it (or with a
 * tuning override, under another name). `vector`, `text` and `morph` are the native read's own
 * lists before fusion, so the pool also holds what one channel finds and fusion drops. A recorded
 * question only sees nodes stored before it was asked, so ids at or past its seq are dropped from
 * every list; the searches ask for more than they keep to make up for it.
 */
import { Array as Arr, Console, Effect, HashMap, Option } from "effect";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { VectorIndex } from "../../src/memory/embedding/vector-index.ts";
import { maxVectorK } from "../../src/memory/native-search/read-protocol.ts";
import { MemorySearch, searchTerms } from "../../src/memory/search.ts";
import { appendRows, type Item, type Need, readRows, type RunRow, setFiles } from "./files.ts";
import { nodeSeqs } from "./nodes.ts";

/** Ids kept per item and run: the judge pools the top 20, scores read the top 20. */
export const keptIds = 30;
/** What the app search is asked for: more than kept, since later nodes are dropped. */
const appLimit = 40;
/** Per-channel depth asked of the native read; the vector channel is capped by the read. */
export const channelDepth = 40;

/** The lists' ids in turns, own project first: the app's merge of text and morph ranks. */
export const alternate = (lists: ReadonlyArray<ReadonlyArray<string>>) =>
  Arr.makeBy(Math.max(0, ...lists.map((list) => list.length)), (rank) =>
    lists.flatMap((list) => list.slice(rank, rank + 1)),
  ).flat();

/** One item's ranked ids per run, before dropping the nodes stored after the question. */
type Ranked = ReadonlyArray<{
  readonly run: string;
  readonly ids: Option.Option<ReadonlyArray<string>>;
  readonly failed?: string;
}>;

export interface SearchRunsInput {
  readonly storage: string;
  /** The name of the app search's run; none skips it. */
  readonly app: Option.Option<string>;
  /** Also write the `vector`, `text` and `morph` runs. */
  readonly channels: boolean;
}

/** Writes the named runs for every item not yet in all of them, one item at a time. */
export const searchRuns = Effect.fn("searchSet.searchRuns")(function* ({
  storage,
  app,
  channels,
}: SearchRunsInput) {
  const files = setFiles(storage);
  const search = yield* MemorySearch;
  const embedder = yield* Embedder;
  const vectors = yield* VectorIndex;
  const runs = [...Option.toArray(app), ...(channels ? ["vector", "text", "morph"] : [])];
  const done = yield* Effect.forEach(runs, (run) =>
    Effect.map(readRows(files.run(run)), (rows) => new Set(rows.map((row) => row.item))),
  );
  const needs = HashMap.fromIterable(
    (yield* readRows(files.needs)).map((need) => [need.need, need] as const),
  );
  const items = (yield* readRows(files.items)).flatMap((item) =>
    done.every((items) => items.has(item.item))
      ? []
      : Option.toArray(HashMap.get(needs, item.need)).map((need) => ({ item, need })),
  );
  yield* Console.log(`items to search ${items.length}; runs ${runs.join(", ")}`);

  const appRanked = (item: Item, need: Need, name: string) =>
    search
      .find({
        query: item.query,
        projectId: need.projectId,
        crossProject: need.crossProject,
        limit: appLimit,
      })
      .pipe(
        Effect.map((result) => ({
          run: name,
          ids: Option.some(result.matches.map((match) => match.id)),
        })),
        Effect.catchTag("NativeMemorySearchFailed", (error) =>
          Effect.succeed({ run: name, ids: Option.none(), failed: error.reason }),
        ),
      );

  const channelRanked = (item: Item, need: Need) =>
    Effect.gen(function* () {
      const query = yield* embedder.embed([item.query], "query").pipe(
        Effect.map((values) => Option.fromNullishOr(values[0])),
        Effect.orElseSucceed(() => Option.none<Float32Array>()),
      );
      const grouped = searchTerms(item.query);
      const allowed = yield* search.allowedProjects(need.projectId, need.crossProject);
      const read = (projects: ReadonlyArray<string>) =>
        vectors.backend
          .read({
            allowedProjects: projects,
            embedder: embedder.identity,
            // Each read transfers its vector's buffer to the worker, so each gets its own copy.
            query: Option.getOrUndefined(Option.map(query, (vector) => new Float32Array(vector))),
            trigramTerms: grouped.trigram,
            shortTerms: grouped.short,
            morphQuery: item.query,
            vectorK: maxVectorK,
            textK: channelDepth,
            morphK: channelDepth,
            textEnabled: true,
            morphEnabled: item.query.trim().length > 0,
            remainingMs: 2000,
            inputBudgetBytes: 1048576,
            outputBudgetBytes: 1048576,
          })
          .pipe(
            // A failed read leaves its lists out; the item's rows say so when every read failed.
            Effect.option,
            Effect.map(Option.map(({ result }) => result)),
            Effect.map(Option.filter((result) => result.kind === "success")),
          );
      // The own project is read on its own first, as the app reads it, then the others together.
      const scopes = Arr.getSomes(
        yield* Effect.forEach(
          [allowed.slice(0, 1), allowed.slice(1)].filter(Arr.isReadonlyArrayNonEmpty),
          read,
        ),
      );
      const ranked = (run: string, ids: ReadonlyArray<string>) =>
        Arr.match(scopes, {
          onEmpty: () => ({ run, ids: Option.none(), failed: "read-failed" }),
          onNonEmpty: () => ({ run, ids: Option.some(ids) }),
        });
      return [
        // Cosine scores compare across reads, so vector hits merge by score.
        ranked(
          "vector",
          scopes
            .flatMap((scope) =>
              scope.vectorIds.map((id, index) => ({ id, score: scope.vectorScores[index]! })),
            )
            .sort((left, right) => right.score - left.score)
            .map(({ id }) => id),
        ),
        ranked("text", alternate(scopes.map((scope) => scope.textIds))),
        ranked("morph", alternate(scopes.map((scope) => scope.morphIds))),
      ];
    });

  /** The run rows of one item: ids stored after a recorded question are dropped. */
  const rowsOf = (item: Item, need: Need, ranked: Ranked) =>
    Effect.map(nodeSeqs(ranked.flatMap(({ ids }) => Option.getOrElse(ids, () => []))), (seqs) =>
      ranked.map(({ run, ids, failed }) => {
        const kept = Option.getOrElse(ids, () => []).filter((id) =>
          Option.match(HashMap.get(seqs, id), {
            onNone: () => false,
            onSome: (seq) => need.beforeSeq === null || seq < need.beforeSeq,
          }),
        );
        const row: RunRow =
          failed === undefined
            ? { item: item.item, ids: kept.slice(0, keptIds) }
            : { item: item.item, ids: [], failed };
        return { run, row };
      }),
    );

  const searched = yield* Effect.forEach(items, ({ item, need }) =>
    Effect.gen(function* () {
      const ranked: Ranked = [
        ...(yield* Effect.forEach(Option.toArray(app), (name) => appRanked(item, need, name))),
        ...(channels ? yield* channelRanked(item, need) : []),
      ];
      const rows = yield* rowsOf(item, need, ranked);
      yield* Effect.forEach(rows, ({ run, row }) => appendRows(files.run(run))([row]), {
        discard: true,
      });
    }),
  );
  yield* Console.log(`searched ${searched.length} items`);
});
