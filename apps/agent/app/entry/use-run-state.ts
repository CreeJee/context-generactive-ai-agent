import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionRunState } from "memory-agent/definitions";
import { useState } from "react";
import { api, ApiError, type WorkflowAction, type WorkflowPhase } from "./api";
import { useSessionEventScope } from "./events/context";
import { appQueryKeys } from "./events/query-keys";
import { noticeOf, type PageView } from "./run-notice";

/** The authoritative durable run/workflow snapshot, refreshed by session SSE invalidations. */
export function useRunState(
  sessionId: string,
  holder: string,
  generating: boolean,
  page: PageView,
) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Run state requires an active project");
  const queryClient = useQueryClient();
  const queryKey = appQueryKeys.session.runState(projectId, sessionId);
  const query = useQuery({
    queryKey,
    queryFn: () => api.sessionRunState(sessionId, holder),
    enabled: !generating,
    staleTime: 0,
  });
  const state = query.data ?? null;
  const [cancelling, setCancelling] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const refresh = async () => {
    const result = await query.refetch();
    if (result.data?.running === null) setCancelPending(false);
    if (!result.data) throw new Error("Run state refresh returned no snapshot");
    return result.data;
  };

  /** Asks the server to stop the run. Resolves false when nothing could be asked (network error). */
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await api.cancelRun(sessionId, holder);
      setCancelPending(!result.stopped);
      await queryClient.invalidateQueries({ queryKey });
      return true;
    } catch (failure) {
      return failure instanceof ApiError && failure.status === 409;
    } finally {
      setCancelling(false);
    }
  };

  const setWorkflowPhase = async (phase: WorkflowPhase) => {
    const workflow = await api.setWorkflowPhase(sessionId, holder, phase);
    queryClient.setQueryData<SessionRunState>(queryKey, (current) =>
      current ? { ...current, workflow } : current,
    );
    return workflow;
  };

  const controlWorkflow = async (action: WorkflowAction) => {
    setControlling(true);
    try {
      const workflow = await api.controlWorkflow(sessionId, holder, action);
      queryClient.setQueryData<SessionRunState>(queryKey, (current) =>
        current ? { ...current, workflow } : current,
      );
      return workflow;
    } finally {
      setControlling(false);
    }
  };

  return {
    cancelling,
    controlling,
    cancel,
    controlWorkflow,
    refresh,
    context: state?.context ?? null,
    workflow: state?.workflow ?? null,
    setWorkflowPhase,
    notice: cancelPending ? ({ kind: "cancel-pending" } as const) : noticeOf(state, page),
  };
}
