import { Function as EffectFunction } from "effect";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type BoardEdit,
  type BoardIntent,
  type DecisionAnswer,
  type GoalPriority,
  type HumanDecisionRequest,
  type WorkflowAction,
  type WorkflowPhase,
} from "../../api";
import { sessionQueries } from "../session";
import { projectQueries } from "../project";

export const useEditBoardMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useEditBoardMutationBody>;
} & typeof useEditBoardMutationBody = EffectFunction.dual(3, useEditBoardMutationBody);
function useEditBoardMutationBody(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (edit: BoardEdit) => api.editBoard(sessionId, holder, edit),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({
          queryKey: sessionQueries.board(projectId, sessionId).queryKey,
        }),
        client.invalidateQueries({
          queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
        }),
      ]),
  });
}

/** Answers a card decision of any session in the project; the board and inbox read it again. */
export const useAnswerDecisionMutation: {
  (holder: string): (projectId: string) => ReturnType<typeof useAnswerDecisionMutationBody>;
} & typeof useAnswerDecisionMutationBody = EffectFunction.dual(2, useAnswerDecisionMutationBody);
function useAnswerDecisionMutationBody(projectId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      answer,
    }: {
      request: Pick<HumanDecisionRequest, "requestId" | "sessionId" | "goalInstanceId" | "cardId">;
      answer: DecisionAnswer;
    }) => api.answerDecision(holder, request, answer),
    onSettled: (_answered, _error, { request }) =>
      Promise.all([
        client.invalidateQueries({
          queryKey: sessionQueries.board(projectId, request.sessionId).queryKey,
        }),
        client.invalidateQueries({
          queryKey: sessionQueries.decisions(projectId, request.sessionId).queryKey,
        }),
        client.invalidateQueries({
          queryKey: sessionQueries.kanban(projectId, request.sessionId).queryKey,
        }),
        client.invalidateQueries({ queryKey: projectQueries.decisions(projectId).queryKey }),
      ]),
  });
}

/** A kanban board action: start, a person's intent for a card, or the Goal's schedule. */
export type KanbanAction =
  | { readonly _tag: "Start" }
  | { readonly _tag: "RestartLoop" }
  | { readonly _tag: "Intent"; readonly intent: BoardIntent }
  | { readonly _tag: "SetPriority"; readonly priority: GoalPriority }
  | { readonly _tag: "SetDependencies"; readonly dependsOn: readonly string[] };

/** Starts the executing Plan as a kanban board, carries out an intent, or changes the schedule. */
export const useKanbanMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useKanbanMutationBody>;
} & typeof useKanbanMutationBody = EffectFunction.dual(3, useKanbanMutationBody);
function useKanbanMutationBody(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: KanbanAction) => {
      switch (action._tag) {
        case "Start":
          return api.startKanban(sessionId, holder);
        case "RestartLoop":
          return api.restartKanbanLoop(sessionId, holder);
        case "Intent":
          return api.boardIntent(sessionId, holder, action.intent);
        case "SetPriority":
          return api.setGoalPriority(sessionId, holder, action.priority);
        case "SetDependencies":
          return api.setGoalDependencies(sessionId, holder, action.dependsOn);
      }
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({
          queryKey: sessionQueries.kanban(projectId, sessionId).queryKey,
        }),
        client.invalidateQueries({
          queryKey: sessionQueries.board(projectId, sessionId).queryKey,
        }),
      ]),
  });
}

export const useRelayedApprovalMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useRelayedApprovalMutationBody>;
} & typeof useRelayedApprovalMutationBody = EffectFunction.dual(3, useRelayedApprovalMutationBody);
function useRelayedApprovalMutationBody(projectId: string, sessionId: string, holder: string) {
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

export const useEnqueueMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useEnqueueMutationBody>;
} & typeof useEnqueueMutationBody = EffectFunction.dual(3, useEnqueueMutationBody);
function useEnqueueMutationBody(projectId: string, sessionId: string, holder: string) {
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

export const useEditQueueMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useEditQueueMutationBody>;
} & typeof useEditQueueMutationBody = EffectFunction.dual(3, useEditQueueMutationBody);
function useEditQueueMutationBody(projectId: string, sessionId: string, holder: string) {
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

export const useResumeTraceTaskMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useResumeTraceTaskMutationBody>;
} & typeof useResumeTraceTaskMutationBody = EffectFunction.dual(3, useResumeTraceTaskMutationBody);
function useResumeTraceTaskMutationBody(projectId: string, sessionId: string, holder: string) {
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

export const useArchiveTraceTaskMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useArchiveTraceTaskMutationBody>;
} & typeof useArchiveTraceTaskMutationBody = EffectFunction.dual(
  3,
  useArchiveTraceTaskMutationBody,
);
function useArchiveTraceTaskMutationBody(projectId: string, sessionId: string, holder: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.archiveWorkTraceTask(sessionId, holder, taskId),
    onSuccess: invalidate,
  });
}

export const useDeleteTraceTaskMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useDeleteTraceTaskMutationBody>;
} & typeof useDeleteTraceTaskMutationBody = EffectFunction.dual(3, useDeleteTraceTaskMutationBody);
function useDeleteTraceTaskMutationBody(projectId: string, sessionId: string, holder: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.deleteWorkTraceTask(sessionId, holder, taskId),
    onSuccess: invalidate,
  });
}

export const useCompactSessionMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useCompactSessionMutationBody>;
} & typeof useCompactSessionMutationBody = EffectFunction.dual(3, useCompactSessionMutationBody);
function useCompactSessionMutationBody(projectId: string, sessionId: string, holder: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.compactSession(sessionId, holder),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId, holder).queryKey,
      }),
  });
}

export const useCancelRunMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useCancelRunMutationBody>;
} & typeof useCancelRunMutationBody = EffectFunction.dual(3, useCancelRunMutationBody);
function useCancelRunMutationBody(projectId: string, sessionId: string, holder: string) {
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

export const useWorkflowMutation: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useWorkflowMutationBody>;
} & typeof useWorkflowMutationBody = EffectFunction.dual(3, useWorkflowMutationBody);
function useWorkflowMutationBody(projectId: string, sessionId: string, holder: string) {
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
