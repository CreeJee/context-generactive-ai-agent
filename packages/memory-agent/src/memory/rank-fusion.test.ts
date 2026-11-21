import { MutableHashMap, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { fuseRanks } from "./rank-fusion.ts";

const score = (fused: MutableHashMap.MutableHashMap<string, number>, id: string) =>
  Option.getOrThrow(MutableHashMap.get(fused, id));

describe("fuseRanks", () => {
  it("rewards agreement between rankings using ranks only", () => {
    const fused = fuseRanks({
      lists: [
        ["vector-only", "both"],
        ["both", "text-only"],
      ],
    });
    expect(score(fused, "vector-only")).toBeCloseTo(0.5);
    expect(score(fused, "both")).toBeGreaterThan(score(fused, "vector-only"));
    expect(score(fused, "text-only")).toBeLessThan(score(fused, "vector-only"));
    expect(score(fuseRanks({ lists: [["a"], ["a"]] }), "a")).toBeCloseTo(1);
  });

  it("a weighted list outvotes the others by its weight", () => {
    const fused = fuseRanks({
      lists: [
        ["exact", "other"],
        ["near", "exact"],
      ],
      weights: [2, 1],
    });
    expect(score(fused, "exact")).toBeGreaterThan(score(fused, "near"));
    expect(score(fuseRanks({ lists: [["a"], ["b"]], weights: [2, 1] }), "a")).toBeCloseTo(2 / 3);
  });
});
