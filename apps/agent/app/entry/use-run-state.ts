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
    // Workflow tools can save a new Goal/Plan before the answer finishes streaming.
    // Keep this query active so session SSE invalidations refetch those snapshots.
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

  /** The server may have running children even when this page has no streaming parent. */
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await api.cancelRun(sessionId, holder);
      setCancelPending(!result.stopped);
      return "requested" as const;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "no_running_run") {
        setCancelPending(false);
        return "idle" as const;
      }
      return "failed" as const;
    } finally {
      try {
        await queryClient.invalidateQueries({ queryKey });
      } finally {
        setCancelling(false);
      }
    }
  };

  // Artifacts and their allowed actions are one server snapshot. Do not merge a mutation's
  // artifact-only response into older permissions. Refetch even after a stale action is refused.
  const mutateWorkflow = async (mutate: () => Promise<SessionRunState["workflow"]>) => {
    setControlling(true);
    try {
      return await mutate();
    } finally {
      try {
        await queryClient.invalidateQueries({ queryKey });
      } finally {
        setControlling(false);
      }
    }
  };

  const setWorkflowPhase = (phase: WorkflowPhase) =>
    mutateWorkflow(() => api.setWorkflowPhase(sessionId, holder, phase));

  const controlWorkflow = (action: WorkflowAction) =>
    mutateWorkflow(() => api.controlWorkflow(sessionId, holder, action));

  return {
    cancelling,
    controlling,
    cancel,
    controlWorkflow,
    refresh,
    context: state?.context ?? null,
    workflow: state?.workflow ?? null,
    actions: state?.actions ?? null,
    setWorkflowPhase,
    notice: cancelPending
      ? ({ kind: "cancel-pending" } as const)
      : generating
        ? null
        : noticeOf(state, page),
  };
}
