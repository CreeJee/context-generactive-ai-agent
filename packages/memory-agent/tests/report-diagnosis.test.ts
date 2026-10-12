import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseDiagnosis } from "../src/report/diagnosis.ts";

describe("report diagnosis answer", () => {
  it.effect("observations without a citation of included evidence become hypotheses", () =>
    Effect.gen(function* () {
      const answer = `\`\`\`json
{"observations":[{"text":"승인 요청이 3번 반복됐다.","evidenceIds":["approval:1","made-up"]},{"text":"서버가 재시작됐다.","evidenceIds":["made-up"]}],"hypotheses":[{"text":"승인 응답이 저장되지 않았을 수 있다."}]}
\`\`\``;
      expect(yield* parseDiagnosis(answer, new Set(["approval:1"]))).toEqual({
        observations: [{ text: "승인 요청이 3번 반복됐다.", evidenceIds: ["approval:1"] }],
        hypotheses: [
          { text: "승인 응답이 저장되지 않았을 수 있다." },
          { text: "서버가 재시작됐다." },
        ],
      });
    }),
  );

  it.effect("a non-JSON answer is a typed invalid_answer failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(parseDiagnosis("모르겠어요", new Set()));
      expect(failure.reason).toBe("invalid_answer");
    }),
  );
});
