/**
 * The search terms of every item, as the app makes them: trigram and short terms from the query's
 * words, and Kiwi's morph terms, both the app's capped list and every distinct term. Search engines
 * benchmarked outside the app (tools/tantivy-bench) read them, so they search the same terms the app
 * would, or every term when they can afford it.
 */
import { Array as Arr, Console, Effect, Schedule } from "effect";
import { MorphAnalyzer } from "../../src/memory/morph/analyzer.ts";
import { morphSearchTerms, searchTerms } from "../../src/memory/search.ts";
import { appendRows, readRows, setFiles } from "./files.ts";

/** Items analyzed per call to Kiwi. */
const itemsPerCall = 50;

/**
 * Waits until Kiwi is loaded; it loads in the background, and searching or analyzing before then
 * leaves morph terms out.
 */
export const readyAnalyzer = Effect.fn("searchSet.readyAnalyzer")(function* () {
  const analyzer = yield* MorphAnalyzer;
  analyzer.warm();
  yield* Effect.sync(() => analyzer.ready()).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("250 millis") }),
    Effect.timeoutOption("2 minutes"),
  );
  return analyzer;
});

export const writeTerms = Effect.fn("searchSet.terms")(function* (storage: string) {
  const files = setFiles(storage);
  const analyzer = yield* readyAnalyzer();
  const done = new Set((yield* readRows(files.terms)).map((row) => row.item));
  const items = (yield* readRows(files.items)).filter((item) => !done.has(item.item));
  yield* Console.log(
    `items to analyze ${items.length}; morph analyzer ${analyzer.ready() ? "ready" : "not ready"}`,
  );
  yield* Effect.forEach(
    Arr.chunksOf(items, itemsPerCall),
    (chunk) =>
      Effect.flatMap(analyzer.terms(chunk.map((item) => item.query)), (tokens) =>
        appendRows(files.terms)(
          chunk.map((item, index) => {
            const grouped = searchTerms(item.query);
            const analyzed = tokens[index] ?? [];
            return {
              item: item.item,
              trigram: grouped.trigram,
              short: grouped.short,
              morph: morphSearchTerms(analyzed),
              morphAll: Arr.dedupe(analyzed.filter((term) => term.length > 0)),
            };
          }),
        ),
      ),
    { discard: true },
  );
});
