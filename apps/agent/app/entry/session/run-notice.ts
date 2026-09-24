import { serverRestartedCode, type SessionRunState } from "memory-agent/definitions";

/** How a session's last run ended, or that it is still going, when that is worth telling the user. */
export type RunNotice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "cancel-pending" }
  | { readonly kind: "restarted" }
  | { readonly kind: "failed"; readonly message: string }
  /** The server is still answering, but this page is no longer receiving it. */
  | { readonly kind: "detached" }
  /** Stopped partway without an approval to answer. */
  | { readonly kind: "stopped" }
  /** Finished, but the last thing it produced was not an answer (e.g. only tool calls). */
  | { readonly kind: "no-answer" };

/** What the page knows besides the run record. */
export interface PageView {
  readonly waitingForApproval: boolean;
  /** The conversation ends with assistant text. */
  readonly answered: boolean;
}

/** The notice for a run record while this page is not generating; null when all is as it looks. */
export function noticeOf(state: SessionRunState | null, page: PageView): RunNotice | null {
  if (!state) return null;
  if (state.running) return { kind: "detached" };
  const lastRun = state.lastRun;
  if (!lastRun) return null;
  // A restart is recorded as an error; the status may have been rewritten since.
  if (lastRun.error?.code === serverRestartedCode) return { kind: "restarted" };
  switch (lastRun.status) {
    case "aborted":
      return { kind: "cancelled" };
    case "failed":
      return { kind: "failed", message: lastRun.error?.message ?? "알 수 없는 오류" };
    case "interrupted":
      return page.waitingForApproval ? null : { kind: "stopped" };
    case "completed":
      return page.answered ? null : { kind: "no-answer" };
    case "running":
      return null;
  }
}
