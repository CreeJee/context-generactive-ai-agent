import { Effect } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { evaluateCompaction } from "../eval/compaction.ts";

describe("long-conversation compaction evaluation", () => {
  it.live("reduces input, preserves more cacheable prefix, and retrieves corrected evidence", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => evaluateCompaction());

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
    }),
  );
});
