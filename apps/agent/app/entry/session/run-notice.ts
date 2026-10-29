import { Data, Function as EffectFunction } from "effect";
import {
  runFailureCodeOf,
  serverRestartedCode,
  type RunFailureCode,
  type SessionRunState,
} from "memory-agent/definitions";
import { WorkflowExecutionState } from "../api";

/** How a session's last run ended, or that it is still going, when that is worth telling the user. */
export type RunNotice = Data.TaggedEnum<{
  cancelled: {};
  "cancel-pending": {};
  restarted: {};
  /** Cut off by a restart before it ran any tool; a new run continues the Plan at `at`. */
  resuming: { readonly at: number };
  /** `code` picks the wording; a general failure (`run_failed`) shows its message. */
  failed: { readonly message: string; readonly code: RunFailureCode };
  /** The server is still answering, but this page is no longer receiving it. */
  detached: {};
  /** Stopped partway without an approval to answer. */
  stopped: {};
  /** Finished, but the last thing it produced was not an answer (e.g. only tool calls). */
  "no-answer": {};
  /** The app repaired a Goal state an earlier version left and stopped its automatic runs. */
  reconciled: {};
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
  // The repair explains the run before it, which an earlier version could not finish.
  if (
    WorkflowExecutionState.$is("stopped")(state.execution) &&
    state.execution.reason === "state_reconciled"
  )
    return RunNotice.reconciled();
  const lastRun = state.lastRun;
  if (!(lastRun !== null)) return null;
  // A restart is recorded as an error; the status may have been rewritten since.
  if (lastRun.error?.code === serverRestartedCode)
    return WorkflowExecutionState.$is("retrying")(state.execution)
      ? RunNotice.resuming({ at: state.execution.retryAt })
      : RunNotice.restarted();
  switch (lastRun.status) {
    case "aborted":
      return RunNotice.cancelled();
    case "failed":
      return RunNotice.failed({
        message: lastRun.error?.message ?? "알 수 없는 오류",
        code: runFailureCodeOf(lastRun.error?.code),
      });
    case "interrupted":
      return page.waitingForApproval ? null : RunNotice.stopped();
    case "completed":
      return page.answered ? null : RunNotice["no-answer"]();
    case "running":
      return null;
  }
}
