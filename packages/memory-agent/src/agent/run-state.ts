import type { RunStatus } from "@tanstack/ai-persistence";
import type { LeaseView } from "../sessions/lease-state.ts";
import type { WorkflowState } from "../workflow/workflow.ts";

/** Browser-safe shapes of the session run endpoints. */

/** Error code on runs that were still producing when the previous server process ended. */
export const serverRestartedCode = "server_restarted";

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
export interface ContextView {
  /**
   * Tokens the model read in its latest request in this conversation: instructions, tools and
   * the conversation. Null before the first.
   */
  readonly usedTokens: number | null;
  /** Tokens the selected model may read. */
  readonly windowTokens: number;
  /** Estimated conversation size past which earlier parts are compacted. */
  readonly compactAtTokens: number;
}

export const contextUsageEvent = "memory-agent.context";
