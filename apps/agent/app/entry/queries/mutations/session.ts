import { Data, Function as EffectFunction } from "effect";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  BoardIntent,
  type BoardEdit,
  type DecisionAnswer,
  type HumanDecisionRequest,
  type ModelSelection,
  type WorkflowAction,
  type WorkflowMove,
} from "../../api";
import { sessionQueries } from "../session";
import { projectQueries } from "../project";

export const useEditBoardMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useEditBoardMutationBody>;
} & typeof useEditBoardMutationBody = EffectFunction.dual(2, useEditBoardMutationBody);
function useEditBoardMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (edit: BoardEdit) => api.editBoard(sessionId, edit),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({
          queryKey: sessionQueries.board(projectId, sessionId).queryKey,
        }),
        client.invalidateQueries({
          queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
        }),
      ]),
  });
}

/** Answers a card decision of any session in the project; the board and inbox read it again. */
export function useAnswerDecisionMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      answer,
    }: {
      request: Pick<
        HumanDecisionRequest,
        "requestId" | "sessionId" | "goalInstanceId" | "cardId" | "factsSeq"
      >;
      answer: DecisionAnswer;
    }) => api.answerDecision(request, answer),
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
export type KanbanAction = Data.TaggedEnum<{
  Start: {};
  RestartLoop: {};
  RecheckOutcomes: {};
  Intent: { readonly intent: BoardIntent };
  SetDependencies: { readonly dependsOn: readonly string[] };
  Retarget: {};
}>;
export const KanbanAction = Data.taggedEnum<KanbanAction>();

const sendKanbanAction = (sessionId: string, action: KanbanAction) =>
  KanbanAction.$match(action, {
    Start: () => api.startKanban(sessionId),
    RestartLoop: () => api.restartKanbanLoop(sessionId),
    RecheckOutcomes: () => api.recheckOutcomes(sessionId),
    Intent: ({ intent }) => api.boardIntent(sessionId, intent),
    SetDependencies: ({ dependsOn }) => api.setGoalDependencies(sessionId, dependsOn),
    Retarget: () => api.retargetKanban(sessionId),
  });

/** The board and loop of a conversation, read again after a kanban action. */
const kanbanKeys = (projectId: string, sessionId: string) => [
  sessionQueries.kanban(projectId, sessionId).queryKey,
  sessionQueries.board(projectId, sessionId).queryKey,
];

/** The conversation a transferred card goes to; its board changes with the sender's. */
const transferTarget = (action: KanbanAction): string | null =>
  KanbanAction.$is("Intent")(action) && BoardIntent.$is("Transfer")(action.intent)
    ? action.intent.toSessionId
    : null;

/** Starts the executing Plan as a kanban board, carries out an intent, or changes the schedule. */
export const useKanbanMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useKanbanMutationBody>;
} & typeof useKanbanMutationBody = EffectFunction.dual(2, useKanbanMutationBody);
function useKanbanMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: KanbanAction) => sendKanbanAction(sessionId, action),
    onSettled: () =>
      Promise.all(
        kanbanKeys(projectId, sessionId).map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

/**
 * A kanban action for any conversation of the project: the board that shows several Plans names
 * the conversation per request. A transfer reads the receiving conversation's board again too.
 */
export function useBoardsKanbanMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      action,
    }: {
      readonly sessionId: string;
      readonly action: KanbanAction;
    }) => sendKanbanAction(sessionId, action),
    onSettled: (_result, _error, { sessionId, action }) => {
      const target = transferTarget(action);
      const keys = [
        ...kanbanKeys(projectId, sessionId),
        ...(target === null ? [] : kanbanKeys(projectId, target)),
        projectQueries.boards(projectId).queryKey,
      ];
      return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
    },
  });
}

/** A board edit for any conversation of the project, as the board showing several Plans sends it. */
export function useBoardsEditMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, edit }: { readonly sessionId: string; readonly edit: BoardEdit }) =>
      api.editBoard(sessionId, edit),
    onSettled: (_result, _error, { sessionId }) =>
      Promise.all(
        [
          sessionQueries.board(projectId, sessionId).queryKey,
          sessionQueries.runState(projectId, sessionId).queryKey,
          projectQueries.boards(projectId).queryKey,
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

export const useRelayedApprovalMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useRelayedApprovalMutationBody>;
} & typeof useRelayedApprovalMutationBody = EffectFunction.dual(2, useRelayedApprovalMutationBody);
function useRelayedApprovalMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, approved }: { approvalId: string; approved: boolean }) =>
      api.answerApproval(sessionId, approvalId, approved),
    // A refused answer means the list changed under the page, so it is read again either way.
    onSettled: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.approvals(projectId, sessionId).queryKey,
      }),
  });
}

export const useEnqueueMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useEnqueueMutationBody>;
} & typeof useEnqueueMutationBody = EffectFunction.dual(2, useEnqueueMutationBody);
function useEnqueueMutationBody(projectId: string, sessionId: string) {
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
    }) => api.enqueue(sessionId, { text, attachmentIds, mode }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: sessionQueries.queue(projectId, sessionId).queryKey }),
  });
}

export const useEditQueueMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useEditQueueMutationBody>;
} & typeof useEditQueueMutationBody = EffectFunction.dual(2, useEditQueueMutationBody);
function useEditQueueMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, edit }: { id: string; edit: Parameters<typeof api.editQueued>[2] }) =>
      api.editQueued(sessionId, id, edit),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: sessionQueries.queue(projectId, sessionId).queryKey }),
  });
}

function useTraceInvalidation(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return () =>
    client.invalidateQueries({ queryKey: sessionQueries.trace(projectId, sessionId).queryKey });
}

export const useResumeTraceTaskMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useResumeTraceTaskMutationBody>;
} & typeof useResumeTraceTaskMutationBody = EffectFunction.dual(2, useResumeTraceTaskMutationBody);
function useResumeTraceTaskMutationBody(projectId: string, sessionId: string) {
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
    }) => api.resumeWorkTraceTask(sessionId, taskId, attemptId, confirmUncertain),
    onSuccess: invalidate,
  });
}

export const useArchiveTraceTaskMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useArchiveTraceTaskMutationBody>;
} & typeof useArchiveTraceTaskMutationBody = EffectFunction.dual(
  2,
  useArchiveTraceTaskMutationBody,
);
function useArchiveTraceTaskMutationBody(projectId: string, sessionId: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.archiveWorkTraceTask(sessionId, taskId),
    onSuccess: invalidate,
  });
}

export const useDeleteTraceTaskMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useDeleteTraceTaskMutationBody>;
} & typeof useDeleteTraceTaskMutationBody = EffectFunction.dual(2, useDeleteTraceTaskMutationBody);
function useDeleteTraceTaskMutationBody(projectId: string, sessionId: string) {
  const invalidate = useTraceInvalidation(projectId, sessionId);
  return useMutation({
    mutationFn: (taskId: string) => api.deleteWorkTraceTask(sessionId, taskId),
    onSuccess: invalidate,
  });
}

export const useCompactSessionMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useCompactSessionMutationBody>;
} & typeof useCompactSessionMutationBody = EffectFunction.dual(2, useCompactSessionMutationBody);
function useCompactSessionMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.compactSession(sessionId),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
      }),
  });
}

/** Saves the model one conversation runs on; null makes it follow the app's selected model. */
export const useSessionModelMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useSessionModelMutationBody>;
} & typeof useSessionModelMutationBody = EffectFunction.dual(2, useSessionModelMutationBody);
function useSessionModelMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: ModelSelection | null) => api.setSessionModel(sessionId, model),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
        client.invalidateQueries({
          queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
        }),
      ]),
  });
}

export const useCancelRunMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useCancelRunMutationBody>;
} & typeof useCancelRunMutationBody = EffectFunction.dual(2, useCancelRunMutationBody);
function useCancelRunMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelRun(sessionId),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
      }),
  });
}

export type WorkflowChange = Data.TaggedEnum<{
  move: { readonly move: WorkflowMove };
  control: { readonly action: WorkflowAction };
}>;
export const WorkflowChange = Data.taggedEnum<WorkflowChange>();

export const useWorkflowMutation: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useWorkflowMutationBody>;
} & typeof useWorkflowMutationBody = EffectFunction.dual(2, useWorkflowMutationBody);
function useWorkflowMutationBody(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: WorkflowChange.$match({
      move: ({ move }) => api.moveWorkflow(sessionId, move),
      control: ({ action }) => api.controlWorkflow(sessionId, action),
    }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
      }),
    // A rejected action can mean the permissions snapshot changed while the page was open.
    onError: () =>
      client.invalidateQueries({
        queryKey: sessionQueries.runState(projectId, sessionId).queryKey,
      }),
  });
}
