import { evaluateCompaction } from "./compaction.ts";

const result = await evaluateCompaction();
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log("# Long-conversation compaction evaluation");
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(
  `- legacy: ${result.legacy.averageInputTokens} avg input tokens, ${percent(result.legacy.averageCacheableRatio)} cacheable prefix, ${result.legacy.providerCalls} provider calls (${result.legacy.summaryCalls} summary)`,
);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(
  `- current: ${result.current.averageInputTokens} avg input tokens, ${percent(result.current.averageCacheableRatio)} cacheable prefix, ${result.current.providerCalls} provider calls (${result.current.summaryCalls} summary)`,
);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(`- input token reduction: ${percent(result.inputTokenReduction)}`);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(`- cacheable-prefix gain: ${percent(result.cacheableRatioGain)}`);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(
  `- evidence reach: ${percent(result.evidenceReachRate)}, correction applied: ${percent(result.correctionAppliedRate)}, retrieval appendix: ${result.retrievalTokens}/600 tokens`,
);
// Native stdout/stderr or SDK logging boundary preserves the existing output format.
// @effect-diagnostics-next-line globalConsole:off
console.log(`- thresholds: ${JSON.stringify(result.thresholds)}`);
if (Object.values(result.thresholds).some((passed) => !passed)) process.exitCode = 1;
