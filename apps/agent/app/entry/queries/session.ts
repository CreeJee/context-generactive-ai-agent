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
  transcript: (projectId: string, sessionId: string) =>
    queryOptions({
      queryKey: [...appQueryKeys.session.root(projectId, sessionId), "transcript"] as const,
      queryFn: () => api.transcript(sessionId),
      staleTime: 0,
    }),
};

export const useRunStateQuery = (projectId: string, sessionId: string, holder: string) =>
  useQuery(sessionQueries.runState(projectId, sessionId, holder));
export const useQueueQuery = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.queue(projectId, sessionId));
export const useSubagentsQuery = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.subagents(projectId, sessionId));
export const useApprovalsQuery = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.approvals(projectId, sessionId));
export const useObservedRunStateQuery = (
  projectId: string,
  sessionId: string,
  holder: string,
  enabled: boolean,
) => useQuery({ ...sessionQueries.runState(projectId, sessionId, holder), enabled });
export const useSessionTraceQuery = (projectId: string, sessionId: string) =>
  useQuery(sessionQueries.trace(projectId, sessionId));
