import { describe, expect, test } from "vite-plus/test";
import { evaluateCompaction } from "../eval/compaction.ts";

describe("long-conversation compaction evaluation", () => {
  test("reduces input, preserves more cacheable prefix, and retrieves corrected evidence", async () => {
    const result = await evaluateCompaction();

    expect(result.thresholds).toEqual({
      inputTokensReduced: true,
      cacheableRatioImproved: true,
      evidenceReached: true,
      correctionApplied: true,
      retrievalWithinBudget: true,
    });
    expect(result.current.averageInputTokens).toBeLessThan(result.legacy.averageInputTokens);
    expect(result.current.averageCacheableRatio).toBeGreaterThan(
      result.legacy.averageCacheableRatio,
    );
    expect(result.current.providerCalls).toBeGreaterThan(result.legacy.providerCalls);
  });
});
