import { describe, expect, it } from "vite-plus/test";
import { namesSomethingExactly, searchTerms } from "./search.ts";

describe("searchTerms", () => {
  it("routes 3+ character terms to trigram FTS and 2-character terms to substring search", () => {
    expect(searchTerms("저장소 결정은 SQLite, 왜?")).toEqual({
      trigram: ["저장소", "결정은", "SQLite"],
      short: [],
    });
    expect(searchTerms("DB 결정")).toEqual({ trigram: [], short: ["DB", "결정"] });
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
