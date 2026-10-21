import { Data, Function as EffectFunction } from "effect";
import { serverRestartedCode, type SessionRunState } from "memory-agent/definitions";

/** How a session's last run ended, or that it is still going, when that is worth telling the user. */
export type RunNotice = Data.TaggedEnum<{
  cancelled: {};
  "cancel-pending": {};
  restarted: {};
  /** Cut off by a restart before it ran any tool; a new run continues the Plan at `at`. */
  resuming: { readonly at: number };
  failed: { readonly message: string };
  /** The server is still answering, but this page is no longer receiving it. */
  detached: {};
  /** Stopped partway without an approval to answer. */
  stopped: {};
  /** Finished, but the last thing it produced was not an answer (e.g. only tool calls). */
  "no-answer": {};
}>;
export const RunNotice = Data.taggedEnum<RunNotice>();

/** What the page knows besides the run record. */
export interface PageView {
  readonly waitingForApproval: boolean;
  /** The conversation ends with assistant text. */
  readonly answered: boolean;
}

/** The notice for a run record while this page is not generating; null when all is as it looks. */
export const noticeOf: {
  (page: PageView): (state: SessionRunState | null) => ReturnType<typeof noticeOfBody>;
} & typeof noticeOfBody = EffectFunction.dual(2, noticeOfBody);
function noticeOfBody(state: SessionRunState | null, page: PageView): RunNotice | null {
  if (!(state !== null)) return null;
  if (state.running !== null) return RunNotice.detached();
  const lastRun = state.lastRun;
  if (!(lastRun !== null)) return null;
  // A restart is recorded as an error; the status may have been rewritten since.
  if (lastRun.error?.code === serverRestartedCode)
    return state.execution?.kind === "retrying"
      ? RunNotice.resuming({ at: state.execution.retryAt })
      : RunNotice.restarted();
  switch (lastRun.status) {
    case "aborted":
      return RunNotice.cancelled();
    case "failed":
      return RunNotice.failed({ message: lastRun.error?.message ?? "알 수 없는 오류" });
    case "interrupted":
      return page.waitingForApproval ? null : RunNotice.stopped();
    case "completed":
      return page.answered ? null : RunNotice["no-answer"]();
    case "running":
      return null;
  }
}
