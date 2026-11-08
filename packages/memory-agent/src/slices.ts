/**
 * Array splitting that slices each piece once.
 *
 * Effect's `Array.chunksOf` and `Array.groupWith` cut one piece at a time and copy the rest of the
 * array for the next cut, so they allocate in proportion to pieces × length. These give the same
 * pieces, each with a single slice.
 */
import { Array as Arr, Function as EffectFunction } from "effect";

/** `items` in pieces of `size` (at least 1), in order; the last piece holds what is left. */
export const piecesOf: {
  (size: number): <A>(items: ReadonlyArray<A>) => Array<Arr.NonEmptyArray<A>>;
} & typeof piecesOfBody = EffectFunction.dual(2, piecesOfBody);
function piecesOfBody<A>(items: ReadonlyArray<A>, size: number): Array<Arr.NonEmptyArray<A>> {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, nth) =>
    items.slice(nth * size, (nth + 1) * size),
  ).filter(Arr.isArrayNonEmpty);
}

/**
 * Runs of consecutive items, as `Array.groupWith` gives them: an item stays in the run while
 * `same(item, first)` holds for the run's first item.
 */
export const runsOf: {
  <A>(
    same: (item: A, first: A) => boolean,
  ): (items: ReadonlyArray<A>) => Array<Arr.NonEmptyArray<A>>;
} & typeof runsOfBody = EffectFunction.dual(2, runsOfBody);
function runsOfBody<A>(
  items: ReadonlyArray<A>,
  same: (item: A, first: A) => boolean,
): Array<Arr.NonEmptyArray<A>> {
  // The index of the first item of each item's run.
  const [, firsts] = Arr.mapAccum(items, -1, (first, item, at): readonly [number, number] => {
    const own = first >= 0 && same(item, items[first]!) ? first : at;
    return [own, own];
  });
  const starts = firsts.flatMap((first, at) => (first === at ? [at] : []));
  return starts
    .map((start, nth) => items.slice(start, starts[nth + 1]))
    .filter(Arr.isArrayNonEmpty);
}
