import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Cause, Effect, Function as EffectFunction } from "effect";
import { isTruthy } from "../../truthy.ts";
import { useState } from "react";
import { isApiError, type WorkflowAction, type WorkflowPhase } from "../api";
import { useProjectScope } from "../events/context";
import { noticeOf, type PageView } from "./run-notice";
import { useRunStateQuery } from "../queries/session";
import { useCancelRunMutation, useWorkflowMutation } from "../queries/mutations/session";

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
  const [cancelPending, setCancelPending] = useState(false);

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const refresh = () =>
    runUiEffect(
      Effect.gen(function* () {
        const result = yield* uiPromise(() => query.refetch());
        if (result.data?.running === null) setCancelPending(false);
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
          setCancelPending(!result.stopped);
          return "requested" as const;
        }),
        Effect.catch((failure) =>
          Effect.sync(() => {
            if (isApiError(failure.cause) && failure.cause.code === "no_running_run") {
              setCancelPending(false);
              return "idle" as const;
            }
            return "failed" as const;
          }),
        ),
      ),
    );

  const setWorkflowPhase = (phase: WorkflowPhase) =>
    workflowMutation.mutateAsync({ kind: "phase", phase });

  const controlWorkflow = (action: WorkflowAction) =>
    workflowMutation.mutateAsync({ kind: "control", action });

  return {
    cancelling: cancelMutation.isPending,
    controlling: workflowMutation.isPending,
    cancel,
    controlWorkflow,
    refresh,
    context: state?.context ?? null,
    workflow: state?.workflow ?? null,
    execution: state?.execution ?? null,
    providerRetry: state?.providerRetry ?? null,
    actions: state?.actions ?? null,
    uncertainRuns: state?.uncertainRuns ?? [],
    setWorkflowPhase,
    notice: cancelPending
      ? ({ kind: "cancel-pending" } as const)
      : generating
        ? null
        : noticeOf(state, page),
  };
}
