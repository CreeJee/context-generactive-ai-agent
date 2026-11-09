import { describe, expect, it } from "vite-plus/test";

import { endingViolations, glossaryViolations, phraseViolations } from "./check.ts";

const rules = (violations: ReadonlyArray<{ readonly rule: string }>) =>
  violations.map(({ rule }) => rule);

describe("phraseViolations", () => {
  it("flags translationese and punctuation the app never uses", () => {
    expect(rules(phraseViolations("설정을 통해 바꿀 수 있어요."))).toEqual([
      "translationese-through",
    ]);
    expect(rules(phraseViolations("저장되어졌어요"))).toEqual(["double-passive"]);
    expect(rules(phraseViolations("완료했어요!"))).toEqual(["exclamation"]);
    expect(rules(phraseViolations("저장했어요 — 다음으로"))).toEqual(["dash"]);
    expect(rules(phraseViolations("이미지를 만들지 못했어요."))).toEqual([]);
  });
});

describe("glossaryViolations", () => {
  const entries = { plan: { use: "계획", avoid: ["Plan", "플랜"] } };

  it("matches a Latin spelling as a whole word only", () => {
    expect(rules(glossaryViolations("Plan을 고쳤어요", entries))).toEqual(["glossary"]);
    expect(rules(glossaryViolations("Planner를 열었어요", entries))).toEqual([]);
  });

  it("matches a Korean spelling with its particles attached", () => {
    expect(rules(glossaryViolations("플랜이 없어요", entries))).toEqual(["glossary"]);
  });
});

describe("endingViolations", () => {
  // Morphemes as Kiwi 0.24.1 tags them.
  it("accepts 해요체 and the noun ending of status labels", () => {
    expect(
      endingViolations("이미지를 만들지 못했어요.", [
        { str: "어요", tag: "EF" },
        { str: ".", tag: "SF" },
      ]),
    ).toEqual([]);
    expect(endingViolations("곧 끝나죠", [{ str: "죠", tag: "EF" }])).toEqual([]);
    expect(endingViolations("파일이 없음", [{ str: "음", tag: "EF" }])).toEqual([]);
  });

  it("flags 합니다체 and 해라체", () => {
    expect(rules(endingViolations("준비됐습니다", [{ str: "습니다", tag: "EF" }]))).toEqual([
      "register",
    ]);
    expect(
      rules(
        endingViolations("저장했다.", [
          { str: "다", tag: "EF" },
          { str: ".", tag: "SF" },
        ]),
      ),
    ).toEqual(["register"]);
  });

  it("reads a connective ending before closing punctuation as the sentence ending", () => {
    expect(
      endingViolations("저장 중이에요…", [
        { str: "에요", tag: "EC" },
        { str: "…", tag: "SE" },
      ]),
    ).toEqual([]);
    expect(
      rules(
        endingViolations("저장 중이다…", [
          { str: "다", tag: "EC" },
          { str: "…", tag: "SE" },
        ]),
      ),
    ).toEqual(["register"]);
  });

  it("flags a full stop after a label", () => {
    expect(
      rules(
        endingViolations("자세히.", [
          { str: "자세히", tag: "MAG" },
          { str: ".", tag: "SF" },
        ]),
      ),
    ).toEqual(["label-period"]);
    expect(endingViolations("이번만 허용", [{ str: "허용", tag: "NNG" }])).toEqual([]);
  });
});
