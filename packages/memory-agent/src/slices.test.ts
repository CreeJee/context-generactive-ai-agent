import { Array as Arr } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { piecesOf, runsOf } from "./slices.ts";

describe("slicing each piece once", () => {
  const lists: ReadonlyArray<ReadonlyArray<number>> = [
    [],
    [1],
    [1, 1, 2, 2, 2, 3, 1, 1],
    // A run keeps an item near its first one, not near the item before: 1, 2, 3 is two runs.
    [1, 2, 3, 4, 5, 9, 9, 8, 0],
    Array.from({ length: 23 }, (_, index) => Math.floor(index / 3) % 4),
  ];

  it("cuts the pieces Array.chunksOf cuts", () => {
    lists.forEach((list) =>
      [1, 2, 5, 30].forEach((size) =>
        expect(piecesOf(list, size)).toEqual(Arr.chunksOf(list, size)),
      ),
    );
  });

  it("finds the runs Array.groupWith finds", () => {
    const nearFirst = (item: number, first: number) => Math.abs(item - first) <= 1;
    lists.forEach((list) =>
      expect(runsOf(list, nearFirst)).toEqual(
        Arr.match(list, {
          onEmpty: () => [],
          onNonEmpty: (items) => Arr.groupWith(items, nearFirst),
        }),
      ),
    );
  });
});
