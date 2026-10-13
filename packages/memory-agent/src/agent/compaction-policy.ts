/** User turns summarized into each immutable block. */
export const summaryBlockTurns = 4;
/**
 * How full the model's context window gets, in percent, before turns are summarized. Below it the
 * conversation is sent as it was said (docs/decisions.md, 2026-10-13).
 */
export const defaultSummaryStartPercent = 25;
/** Latest user turns always sent in their original form. */
export const recentRawUserTurns = 2;
/** Maximum memory leads added after compaction omitted original content. */
export const retrievalLeadLimit = 5;
/** Estimated-token ceiling for the variable retrieval appendix. */
export const retrievalTokenLimit = 600;
