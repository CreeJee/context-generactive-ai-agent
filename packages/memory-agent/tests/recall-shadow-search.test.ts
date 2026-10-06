// Test/benchmark SDK boundary uses native Promise callbacks, I/O fixtures and synchronous codec assertions.
// @effect-diagnostics asyncFunction:off globalConsole:off processEnv:off
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { evaluateRecallShadowSearch } from "../eval/recall-shadow-search.ts";

test("actual synthetic retrieval stays project-only and records unknown answer correctness", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(evaluateRecallShadowSearch({ textOnly: true })),
  );
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
    result.cases.find((item) => item.id === "va-project-boundary")?.rankings[0].rankedEvidenceIds,
  ).toEqual(["ev-va-maple-new-01"]);
});

test.skipIf(process.env.RECALL_SHADOW_REAL !== "1")(
  "cached offline actual retrieval report",
  async () => {
    const result = await Effect.runPromise(Effect.scoped(evaluateRecallShadowSearch()));
    console.log(JSON.stringify(result));
    expect(
      result.cases.every((item) =>
        item.rankings.every((ranking) => ranking.wrongProjectCount === 0),
      ),
    ).toBe(true);
  },
  120_000,
);
