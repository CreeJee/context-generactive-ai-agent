import { Schema } from "effect";
import { LeaseView } from "../sessions/contracts.ts";
import {
  ProviderRetryView,
  UncertainRun,
  WorkflowActions,
  WorkflowDisplay,
  WorkflowExecutionState,
  WorkflowState,
} from "../workflow/contracts.ts";

/**
 * Browser-safe shapes of the session run endpoints. This module imports no server code, so the
 * browser bundle can use it.
 */

/**
 * How a run stands, as `chat_runs.status` keeps it. `interrupted` waits for the user; the rest but
 * `running` are terminal.
 */
export const RunStatus = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "failed",
  "aborted",
]);
export type RunStatus = typeof RunStatus.Type;

/** Error code on runs that were still producing when the previous server process ended. */
export const serverRestartedCode = "server_restarted";
/** The error of those runs. */
export const serverRestartedMessage = "The server stopped before this answer finished.";

/** Error code after the user discards an approval whose continuation can no longer start. */
export const interruptContinuationLostCode = "interrupt_continuation_lost";

/** Answer to a cancel: `stopped` is false when the run had not ended by the time we answered. */
export const CancelResult = Schema.Struct({
  runId: Schema.String,
  stopped: Schema.Boolean,
  status: Schema.NullOr(RunStatus),
});
export type CancelResult = typeof CancelResult.Type;

/**
 * Answer to `/compact`: how many earlier tool outputs the model is no longer sent in full, how
 * many more turns now go as their summary, and the conversation's estimated tokens before and
 * after. `summaryFailed` when the turns could not be summarized; the tool output is cleared anyway.
 */
export const CompactResult = Schema.Struct({
  cleared: Schema.Finite,
  summarizedTurns: Schema.Finite,
  summaryFailed: Schema.Boolean,
  tokensBefore: Schema.Finite,
  tokensAfter: Schema.Finite,
});
export type CompactResult = typeof CompactResult.Type;

/** The strongest compaction operation applied to a model request. */
export const CompactionStage = Schema.Literals([
  "none",
  "clear-answered",
  "summarize",
  "leave-out",
]);
export type CompactionStage = typeof CompactionStage.Type;

/**
 * How much of the model's context the conversation takes. Also sent live during a run as the
 * `memory-agent.context` custom event.
 */
export const ContextView = Schema.Struct({
  /**
   * Tokens the model read in its latest request in this conversation: instructions, tools and
   * the conversation. Null before the first.
   */
  usedTokens: Schema.NullOr(Schema.Finite),
  /** Prompt tokens served from the provider cache. Null when the provider did not report it. */
  cachedTokens: Schema.NullOr(Schema.Finite),
  /** `cachedTokens / usedTokens`. Null when either value was unavailable or input was empty. */
  cacheRatio: Schema.NullOr(Schema.Finite),
  /** The strongest compaction operation applied to the latest model request. */
  compactionStage: Schema.NullOr(CompactionStage),
  /** Model-advertised input window, or a fallback used only for compaction. */
  windowTokens: Schema.Finite,
  /** Whether windowTokens came from the selected model's catalog metadata. */
  windowKnown: Schema.Boolean,
  /** Estimated conversation size past which earlier parts are compacted. */
  compactAtTokens: Schema.Finite,
});
export type ContextView = typeof ContextView.Type;

/** `GET /api/sessions/:session`: run state that the transcript does not carry. */
export const SessionRunState = Schema.Struct({
  running: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
  lastRun: Schema.NullOr(
    Schema.Struct({
      runId: Schema.String,
      status: RunStatus,
      error: Schema.NullOr(
        Schema.Struct({ message: Schema.String, code: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
  /** Whether the asking page may change the session. */
  lease: LeaseView,
  context: ContextView,
  /** Durable Goal/Plan phase and artifacts for this conversation. */
  workflow: WorkflowState,
  /** A note beside the workflow that its state alone does not show. */
  display: Schema.optionalKey(Schema.NullOr(WorkflowDisplay)),
  execution: Schema.optionalKey(WorkflowExecutionState),
  /** The latest pending wait before resending a provider request that was never sent. */
  providerRetry: Schema.optionalKey(Schema.NullOr(ProviderRetryView)),
  /** Server decisions for this snapshot and requesting page; mutations recheck latest state. */
  actions: WorkflowActions,
  /** Ended Goal runs whose tools left their outcome unknown; a new run waits for the user. */
  uncertainRuns: Schema.Array(UncertainRun),
});
export type SessionRunState = typeof SessionRunState.Type;

export const contextUsageEvent = "memory-agent.context";
