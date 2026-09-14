import type { RunStatus } from "@tanstack/ai-persistence";

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
}

/** Answer to a cancel: `stopped` is false when the run had not ended by the time we answered. */
export interface CancelResult {
  readonly runId: string;
  readonly stopped: boolean;
  readonly status: RunStatus | null;
}
