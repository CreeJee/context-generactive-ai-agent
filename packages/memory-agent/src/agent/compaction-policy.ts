/**
 * How full the model's context window gets, in percent, before the conversation's earlier turns
 * are summarized after a run. Below it the conversation is sent as it was said (docs/decisions.md,
 * 2026-10-13).
 */
export const defaultSummaryStartPercent = 25;
/** Latest user turns always sent in their original form. */
export const recentRawUserTurns = 2;
/** How long a session's summary gets, in characters. */
export const summaryCharacters = 6_000;
/** How much of what is summarized at once the summarizer reads, in characters. */
export const summaryInputCharacters = 60_000;
/** How much of one user message is carried where the message itself is not sent, in characters. */
export const userMessageCharacters = 3_000;
/** Maximum memory leads added after compaction omitted original content. */
export const retrievalLeadLimit = 5;
/** Estimated-token ceiling for the variable retrieval appendix. */
export const retrievalTokenLimit = 600;
/** Latest steps of the run in progress always sent, never left out; their outputs may be cleared. */
export const recentRawSteps = 10;
/**
 * Summaries that fail in a row before a run stops asking for them. A timeout or a dropped
 * connection passes, so one failure does not end them; a summary made resets the count.
 */
export const summaryFailureLimit = 3;
