import { Console, Effect } from "effect";
import { evaluateCompactionEffect } from "./compaction.ts";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const report = Effect.tap(evaluateCompactionEffect, (result) =>
  Console.log(
    [
      "# Long-conversation compaction evaluation",
      `- legacy: ${result.legacy.averageInputTokens} avg input tokens, ${percent(result.legacy.averageCacheableRatio)} cacheable prefix, ${result.legacy.providerCalls} provider calls (${result.legacy.summaryCalls} summary)`,
      `- current: ${result.current.averageInputTokens} avg input tokens, ${percent(result.current.averageCacheableRatio)} cacheable prefix, ${result.current.providerCalls} provider calls (${result.current.summaryCalls} summary)`,
      `- input token reduction: ${percent(result.inputTokenReduction)}`,
      `- cacheable-prefix gain: ${percent(result.cacheableRatioGain)}`,
      `- evidence reach: ${percent(result.evidenceReachRate)}, correction applied: ${percent(result.correctionAppliedRate)}, retrieval appendix: ${result.retrievalTokens}/600 tokens`,
      `- thresholds: ${JSON.stringify(result.thresholds)}`,
    ].join("\n"),
  ),
);
const result = await Effect.runPromise(report);
if (Object.values(result.thresholds).some((passed) => !passed)) process.exitCode = 1;
