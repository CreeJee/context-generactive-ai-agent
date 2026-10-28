import { Function as EffectFunction } from "effect";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { appQueryKeys } from "./keys";

export const sessionQueries = {
  runState: (projectId: string, sessionId: string, holder: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.runState(projectId, sessionId),
      queryFn: () => api.sessionRunState(sessionId, holder),
      staleTime: 0,
    }),
  queue: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.queue(projectId, sessionId),
      queryFn: () => api.queue(sessionId),
    }),
  subagents: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.subagents(projectId, sessionId),
      queryFn: () => api.subagents(sessionId),
    }),
  approvals: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.approvals(projectId, sessionId),
      queryFn: () => api.relayedApprovals(sessionId),
    }),
  trace: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.trace(projectId, sessionId),
      queryFn: () => api.workTrace(sessionId),
    }),
  board: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.board(projectId, sessionId),
      queryFn: () => api.board(sessionId),
      staleTime: 0,
    }),
  decisions: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.decisions(projectId, sessionId),
      queryFn: () => api.decisions(sessionId),
      staleTime: 0,
    }),
  kanban: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.kanban(projectId, sessionId),
      queryFn: () => api.kanban(sessionId),
      staleTime: 0,
    }),
  btw: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: appQueryKeys.session.btw(projectId, sessionId),
      queryFn: () => api.btwThreads(sessionId),
    }),
};

const useRunStateQueryBody = (projectId: string, sessionId: string, holder: string) =>
  useQuery(sessionQueries.runState(projectId, sessionId, holder));
export const useRunStateQuery: {
  (
    sessionId: string,
    holder: string,
  ): (projectId: string) => ReturnType<typeof useRunStateQueryBody>;
} & typeof useRunStateQueryBody = EffectFunction.dual(3, useRunStateQueryBody);
const useQueueQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.queue(projectId, sessionId));
export const useQueueQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useQueueQueryBody>;
} & typeof useQueueQueryBody = EffectFunction.dual(2, useQueueQueryBody);
const useSubagentsQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.subagents(projectId, sessionId));
export const useSubagentsQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useSubagentsQueryBody>;
} & typeof useSubagentsQueryBody = EffectFunction.dual(2, useSubagentsQueryBody);
const useApprovalsQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.approvals(projectId, sessionId));
export const useApprovalsQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useApprovalsQueryBody>;
} & typeof useApprovalsQueryBody = EffectFunction.dual(2, useApprovalsQueryBody);
const useBoardQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.board(projectId, sessionId));
export const useBoardQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useBoardQueryBody>;
} & typeof useBoardQueryBody = EffectFunction.dual(2, useBoardQueryBody);
const useDecisionsQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.decisions(projectId, sessionId));
export const useDecisionsQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useDecisionsQueryBody>;
} & typeof useDecisionsQueryBody = EffectFunction.dual(2, useDecisionsQueryBody);
const useKanbanQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.kanban(projectId, sessionId));
export const useKanbanQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useKanbanQueryBody>;
} & typeof useKanbanQueryBody = EffectFunction.dual(2, useKanbanQueryBody);
const useObservedRunStateQueryBody = (
  projectId: string,
  sessionId: string,
  holder: string,
  enabled: boolean,
) => useQuery({ ...sessionQueries.runState(projectId, sessionId, holder), enabled });
export const useObservedRunStateQuery: {
  (
    sessionId: string,
    holder: string,
    enabled: boolean,
  ): (projectId: string) => ReturnType<typeof useObservedRunStateQueryBody>;
} & typeof useObservedRunStateQueryBody = EffectFunction.dual(4, useObservedRunStateQueryBody);
const useSessionTraceQueryBody = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.trace(projectId, sessionId));
export const useSessionTraceQuery: {
  (sessionId: string): (projectId: string) => ReturnType<typeof useSessionTraceQueryBody>;
} & typeof useSessionTraceQueryBody = EffectFunction.dual(2, useSessionTraceQueryBody);
