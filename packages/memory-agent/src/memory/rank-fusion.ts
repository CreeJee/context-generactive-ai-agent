import { Iterable, MutableHashMap, Option } from "effect";

/** Standard Reciprocal Rank Fusion constant; damps the gap between neighbouring ranks. */
const fusionK = 60;

/**
 * Merges ranked id lists by Reciprocal Rank Fusion. Cosine and BM25 scores are not comparable,
 * so only ranks are used. A node first in every list gets 1; first in one of two equally weighted
 * lists gets 0.5. Equal scores keep the order of the lists: a node the first list holds comes out
 * ahead.
 */
export function fuseRanks(input: {
  readonly lists: readonly (readonly string[])[];
  readonly weights?: readonly number[];
}): MutableHashMap.MutableHashMap<string, number> {
  const { lists, weights = input.lists.map(() => 1) } = input;
  const scores = MutableHashMap.empty<string, number>();
  lists.forEach((list, index) => {
    const weight = weights[index] ?? 1;
    list.forEach((id, rank) =>
      MutableHashMap.set(
        scores,
        id,
        (Option.getOrUndefined(MutableHashMap.get(scores, id)) ?? 0) +
          weight / (fusionK + rank + 1),
      ),
    );
  });
  const best = weights.reduce((sum, weight) => sum + weight, 0) / (fusionK + 1);
  return MutableHashMap.fromIterable(
    Iterable.map(scores, ([id, score]) => [id, score / best] as const),
  );
}
