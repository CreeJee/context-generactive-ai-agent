import { MutableHashMap, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { fuseRanks, namesSomethingExactly, searchTerms } from "./search.ts";

const score = (fused: MutableHashMap.MutableHashMap<string, number>, id: string) =>
  Option.getOrThrow(MutableHashMap.get(fused, id));

describe("searchTerms", () => {
  it("routes 3+ character terms to trigram FTS and 2-character terms to substring search", () => {
    expect(searchTerms("저장소 결정은 SQLite, 왜?")).toEqual({
      trigram: ["저장소", "결정은", "SQLite"],
      short: [],
    });
    expect(searchTerms("DB 결정")).toEqual({ trigram: [], short: ["DB", "결정"] });
  });
});

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

describe("namesSomethingExactly", () => {
  it.each([
    "ERR_PNPM_OUTDATED_LOCKFILE",
    "TS2345 오류",
    "payment.test.ts 타임아웃",
    "useSessionLease",
    "Access-Control-Allow-Origin",
    "ECONNRESET",
    "EADDRINUSE 5174",
    "redis:7.2-alpine",
  ])("an error code, path or identifier: %s", (query) => {
    expect(namesSomethingExactly(query)).toBe(true);
  });

  it.each([
    "로그 형식을 뭐로 정했었지?",
    "주 DB를 무엇으로 하기로 했나요",
    "ORM 도입했었나?",
    "PG사 어디랑 계약했어?",
    "Node 버전 고정",
  ])("a question in words: %s", (query) => {
    expect(namesSomethingExactly(query)).toBe(false);
  });
});
