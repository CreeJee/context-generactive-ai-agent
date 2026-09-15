import type { RunStatus } from "@tanstack/ai-persistence";
import type { LeaseView } from "../sessions/lease-state.ts";

/** Browser-safe shapes of the session run endpoints. */

/** Error code on runs that were still producing when the previous server process ended. */
export const serverRestartedCode = "server_restarted";

/** Error code on runs stopped after too many rounds of tool calls without a final answer. */
export const toolRoundLimitCode = "tool_round_limit";

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
}

/** Answer to a cancel: `stopped` is false when the run had not ended by the time we answered. */
export interface CancelResult {
  readonly runId: string;
  readonly stopped: boolean;
  readonly status: RunStatus | null;
}
