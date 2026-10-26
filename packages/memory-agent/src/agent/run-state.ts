import type { RunStatus } from "@tanstack/ai-persistence";
import type { LeaseView } from "../sessions/lease-state.ts";
import type { WorkflowActions } from "../workflow/actions.ts";
import type { WorkflowState } from "../workflow/workflow.ts";
import type { WorkflowExecutionState } from "../workflow/execution.ts";
import type { ProviderRetryView } from "../workflow/provider-retry.ts";
import type { UncertainRun } from "../workflow/uncertain-runs.ts";

/** Browser-safe shapes of the session run endpoints. */

/** Error code on runs that were still producing when the previous server process ended. */
export const serverRestartedCode = "server_restarted";
/** The error of those runs. */
export const serverRestartedMessage = "The server stopped before this answer finished.";

/** Error code after the user discards an approval whose continuation can no longer start. */
export const interruptContinuationLostCode = "interrupt_continuation_lost";

/** `GET /api/sessions/:session`: run state that the transcript does not carry. */
export interface SessionRunState {
  readonly running: { readonly runId: string } | null;
  readonly lastRun: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly error: { readonly message: string; readonly code?: string } | null;
  } | null;
  /** Whether the asking page may change the session. */
  readonly lease: LeaseView;
  readonly context: ContextView;
  /** Durable Goal/Plan phase and artifacts for this conversation. */
  readonly workflow: WorkflowState;
  readonly execution?: WorkflowExecutionState;
  /** The latest pending wait before resending a provider request that was never sent. */
  readonly providerRetry?: ProviderRetryView | null;
  /** Server decisions for this snapshot and requesting page; mutations recheck latest state. */
  readonly actions: WorkflowActions;
  /** Ended Goal runs whose tools left their outcome unknown; a new run waits for the user. */
  readonly uncertainRuns: readonly UncertainRun[];
}

/** Answer to a cancel: `stopped` is false when the run had not ended by the time we answered. */
export interface CancelResult {
  readonly runId: string;
  readonly stopped: boolean;
  readonly status: RunStatus | null;
}

/**
 * Answer to `/compact`: how many earlier tool outputs the model is no longer sent in full, how
 * many more turns now go as their summary, and the conversation's estimated tokens before and
 * after. `summaryFailed` when the turns could not be summarized; the tool output is cleared anyway.
 */
export interface CompactResult {
  readonly cleared: number;
  readonly summarizedTurns: number;
  readonly summaryFailed: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * How much of the model's context the conversation takes. Also sent live during a run as the
 * `memory-agent.context` custom event.
 */
export type CompactionStage = "none" | "clear-answered" | "summarize" | "leave-out";

export type ContextView = {
  /**
   * Tokens the model read in its latest request in this conversation: instructions, tools and
   * the conversation. Null before the first.
   */
  readonly usedTokens: number | null;
  /** Prompt tokens served from the provider cache. Null when the provider did not report it. */
  readonly cachedTokens: number | null;
  /** `cachedTokens / usedTokens`. Null when either value was unavailable or input was empty. */
  readonly cacheRatio: number | null;
  /** The strongest compaction operation applied to the latest model request. */
  readonly compactionStage: CompactionStage | null;
  /** Model-advertised input window, or a fallback used only for compaction. */
  readonly windowTokens: number;
  /** Whether windowTokens came from the selected model's catalog metadata. */
  readonly windowKnown: boolean;
  /** Estimated conversation size past which earlier parts are compacted. */
  readonly compactAtTokens: number;
};

export const contextUsageEvent = "memory-agent.context";
