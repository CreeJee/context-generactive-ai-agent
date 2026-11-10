import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Cause, Effect, Function as EffectFunction } from "effect";
import { isTruthy } from "../../truthy.ts";
import { useState } from "react";
import { isApiError, type WorkflowAction, type WorkflowMove } from "../api";
import { useProjectScope } from "../events/context";
import { noticeOf, RunNotice, type PageView } from "./run-notice";
import { useRunStateQuery } from "../queries/session";
import {
  useCancelRunMutation,
  useWorkflowMutation,
  WorkflowChange,
} from "../queries/mutations/session";

/** The authoritative durable run/workflow snapshot, refreshed by session SSE invalidations. */
export const useRunState: {
  (
    holder: string,
    generating: boolean,
    page: PageView,
  ): (sessionId: string) => ReturnType<typeof useRunStateBody>;
} & typeof useRunStateBody = EffectFunction.dual(4, useRunStateBody);
function useRunStateBody(sessionId: string, holder: string, generating: boolean, page: PageView) {
  const projectId = useProjectScope("run_state");
  const cancelMutation = useCancelRunMutation(projectId, sessionId, holder);
  const workflowMutation = useWorkflowMutation(projectId, sessionId, holder);
  const query = useRunStateQuery(projectId, sessionId, holder);
  const state = query.data ?? null;
  /** The run a cancel was asked for that had not stopped when the server answered. */
  const [cancelAsked, setCancelAsked] = useState<string | null>(null);
  // Asked to stop until the run state no longer shows that run going, however it learns so.
  const cancelPending = cancelAsked !== null && state?.running?.runId === cancelAsked;

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const refresh = () =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() => query.refetch());
        if (!isTruthy(result.data))
          return yield* new Cause.UnknownError(new Error("Run state refresh returned no snapshot"));
        return result.data;
      }),
    );

  /** The server may have running children even when this page has no streaming parent. */
  const cancel = () =>
    runUiEffect(
      uiPromise(() => cancelMutation.mutateAsync()).pipe(
        Effect.map((result) => {
          setCancelAsked(result.stopped ? null : result.runId);
          return "requested" as const;
        }),
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() =>
            isApiError(failure.cause) && failure.cause.code === "no_running_run"
              ? ("idle" as const)
              : ("failed" as const),
          ),
        ),
      ),
    );

  const moveWorkflow = (move: WorkflowMove) =>
    workflowMutation.mutateAsync(WorkflowChange.move({ move }));

  const controlWorkflow = (action: WorkflowAction) =>
    workflowMutation.mutateAsync(WorkflowChange.control({ action }));

  return {
    cancelling: cancelMutation.isPending,
    controlling: workflowMutation.isPending,
    cancel,
    controlWorkflow,
    refresh,
    /** The run the server is answering with, whether or not this page reads it. */
    running: state?.running ?? null,
    context: state?.context ?? null,
    workflow: state?.workflow ?? null,
    display: state?.display ?? null,
    execution: state?.execution ?? null,
    providerRetry: state?.providerRetry ?? null,
    actions: state?.actions ?? null,
    uncertainRuns: state?.uncertainRuns ?? [],
    moveWorkflow,
    notice: cancelPending
      ? RunNotice["cancel-pending"]()
      : generating
        ? null
        : noticeOf(state, page),
  };
}
