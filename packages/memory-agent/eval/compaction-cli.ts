import { Console, Effect } from "effect";
import { evaluateCompactionEffect } from "./compaction.ts";

const result = await Effect.runPromise(evaluateCompactionEffect);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
Effect.runSync(Console.log("# Long-conversation compaction evaluation"));
Effect.runSync(
  Console.log(
    `- legacy: ${result.legacy.averageInputTokens} avg input tokens, ${percent(result.legacy.averageCacheableRatio)} cacheable prefix, ${result.legacy.providerCalls} provider calls (${result.legacy.summaryCalls} summary)`,
  ),
);
Effect.runSync(
  Console.log(
    `- current: ${result.current.averageInputTokens} avg input tokens, ${percent(result.current.averageCacheableRatio)} cacheable prefix, ${result.current.providerCalls} provider calls (${result.current.summaryCalls} summary)`,
  ),
);
Effect.runSync(Console.log(`- input token reduction: ${percent(result.inputTokenReduction)}`));
Effect.runSync(Console.log(`- cacheable-prefix gain: ${percent(result.cacheableRatioGain)}`));
Effect.runSync(
  Console.log(
    `- evidence reach: ${percent(result.evidenceReachRate)}, correction applied: ${percent(result.correctionAppliedRate)}, retrieval appendix: ${result.retrievalTokens}/600 tokens`,
  ),
);
Effect.runSync(Console.log(`- thresholds: ${JSON.stringify(result.thresholds)}`));
if (Object.values(result.thresholds).some((passed) => !passed)) process.exitCode = 1;
