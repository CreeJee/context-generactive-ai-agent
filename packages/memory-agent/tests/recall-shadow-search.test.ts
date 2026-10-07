import { it as effectTest } from "@effect/vitest";
import { Config, Effect } from "effect";
import { expect } from "vite-plus/test";
import { evaluateRecallShadowSearch } from "../eval/recall-shadow-search.ts";

effectTest.effect(
  "actual synthetic retrieval stays project-only and records unknown answer correctness",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(evaluateRecallShadowSearch({ textOnly: true }));
      expect(result.mode).toBe("degraded-text-only-baseline");
      expect(result.sourceCorrectness).toBe("unknown");
      expect(result.fullActivation).toBe(false);
      expect(result.cases).toHaveLength(10);
      for (const item of result.cases) {
        expect(item.rankings.map((ranking) => ranking.k)).toEqual([5, 10, 16]);
        for (const ranking of item.rankings) {
          expect(ranking.wrongProjectCount).toBe(0);
          expect(ranking.degraded).toContain("vector");
        }
      }
      expect(
        result.cases.find((item) => item.id === "tr-empty-search")?.rankings[0].rankedEvidenceIds,
      ).toEqual([]);
      expect(
        result.cases.find((item) => item.id === "va-project-boundary")?.rankings[0]
          .rankedEvidenceIds,
      ).toEqual(["ev-va-maple-new-01"]);
    }),
);

const realEnabled = Effect.runSync(
  Config.String("RECALL_SHADOW_REAL").pipe(
    Config.withDefault(""),
    Config.map((value) => value === "1"),
  ),
);

effectTest.effect.skipIf(!realEnabled)(
  "cached offline actual retrieval report",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(evaluateRecallShadowSearch());
      expect(
        result.cases.every((item) =>
          item.rankings.every((ranking) => ranking.wrongProjectCount === 0),
        ),
      ).toBe(true);
    }),
  120_000,
);
