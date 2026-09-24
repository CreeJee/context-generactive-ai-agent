import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type WorkflowAction, type WorkflowPhase } from "../../api";
import { sessionQueries } from "../session";
import { projectQueries } from "../project";

export function useRelayedApprovalMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, approved }: { approvalId: string; approved: boolean }) =>
      api.answerApproval(sessionId, holder, approvalId, approved),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.approvals(projectId, sessionId).queryKey,
      }),
  });
}

export function useEnqueueMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      text,
      attachmentIds,
      mode,
    }: {
      text: string;
      attachmentIds: readonly string[];
      mode: "queue" | "steer";
    }) => api.enqueue(sessionId, holder, { text, attachmentIds, mode }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: sessionQueries.queue(projectId, sessionId).queryKey }),
  });
}

export function useEditQueueMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, edit }: { id: string; edit: Parameters<typeof api.editQueued>[3] }) =>
      api.editQueued(sessionId, holder, id, edit),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: sessionQueries.queue(projectId, sessionId).queryKey }),
  });
}

function useTraceInvalidation(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: sessionQueries.trace(projectId, sessionId).queryKey }),
      client.invalidateQueries({ queryKey: projectQueries.trace(projectId).queryKey }),
    ]);
}

export function useResumeTraceTaskMutation(projectId: string, sessionId: string, holder: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: ({
      taskId,
      attemptId,
      confirmUncertain,
    }: {
      taskId: string;
      attemptId: string;
      confirmUncertain: boolean;
    }) => api.resumeWorkTraceTask(sessionId, holder, taskId, attemptId, confirmUncertain),
    onSuccess: invalidate,
  });
}

export function useArchiveTraceTaskMutation(projectId: string, sessionId: string, holder: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.archiveWorkTraceTask(sessionId, holder, taskId),
    onSuccess: invalidate,
  });
}

export function useDeleteTraceTaskMutation(projectId: string, sessionId: string, holder: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.deleteWorkTraceTask(sessionId, holder, taskId),
    onSuccess: invalidate,
  });
}

export function useCompactSessionMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.compactSession(sessionId, holder),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
      }),
  });
}

export function useCancelRunMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelRun(sessionId, holder),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
      }),
  });
}

type WorkflowChange =
  | { readonly kind: "phase"; readonly phase: WorkflowPhase }
  | { readonly kind: "control"; readonly action: WorkflowAction };

export function useWorkflowMutation(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: WorkflowChange) => {
      switch (change.kind) {
        case "phase":
          return api.setWorkflowPhase(sessionId, holder, change.phase);
        case "control":
          return api.controlWorkflow(sessionId, holder, change.action);
      }
    },
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
      }),
    // A rejected action can mean the permissions snapshot changed while the page was open.
    onError: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
      }),
  });
}
