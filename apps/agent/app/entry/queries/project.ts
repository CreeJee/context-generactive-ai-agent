import { Function as EffectFunction } from "effect";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { api } from "../api";
import { appQueryKeys } from "./keys";

export const projectQueries = {
  sessions: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.sessions(projectId),
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      queryFn: async () => ({
        active: await api.sessions(projectId),
        archived: await api.archivedSessions(projectId),
      }),
    }),
  mcp: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.mcp(projectId),
      queryFn: () => api.mcpServers(projectId),
    }),
  agents: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.agents(projectId),
      queryFn: () => api.externalAgents(projectId),
    }),
  skills: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.skills(projectId),
      queryFn: () => api.skills(projectId),
    }),
  trace: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.trace(projectId),
      queryFn: () => api.projectWorkTrace(projectId),
    }),
  traceTask: (projectId: string, taskId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.traceTask(projectId, taskId),
      queryFn: () => api.projectWorkTraceTask(projectId, taskId),
    }),
};

/** A project can be absent while the URL and project list settle. */
export function useProjectSessionsQuery(projectId: string | null) {
  return useQuery({
    ...projectQueries.sessions(projectId ?? ""),
    enabled: projectId !== null,
  });
}

export const useAgentsQuery = (projectId: string | null) =>
  useQuery({ ...projectQueries.agents(projectId ?? ""), enabled: projectId !== null });
const useSkillsQueryBody = (projectId: string, enabled: boolean) =>
  useQuery({ ...projectQueries.skills(projectId), enabled });
export const useSkillsQuery: {
  (enabled: boolean): (projectId: string) => ReturnType<typeof useSkillsQueryBody>;
} & typeof useSkillsQueryBody = EffectFunction.dual(2, useSkillsQueryBody);
export const useProjectTraceQuery = (projectId: string) =>
  useQuery(projectQueries.trace(projectId));
const useProjectTraceTaskQueryBody = (projectId: string, taskId: string | null) =>
  useQuery({ ...projectQueries.traceTask(projectId, taskId ?? ""), enabled: taskId !== null });
export const useProjectTraceTaskQuery: {
  (taskId: string | null): (projectId: string) => ReturnType<typeof useProjectTraceTaskQueryBody>;
} & typeof useProjectTraceTaskQueryBody = EffectFunction.dual(2, useProjectTraceTaskQueryBody);
export const useSuspenseMcpQuery = (projectId: string) =>
  useSuspenseQuery(projectQueries.mcp(projectId));
export const useSuspenseAgentsQuery = (projectId: string) =>
  useSuspenseQuery(projectQueries.agents(projectId));
export const useSuspenseSkillsQuery = (projectId: string) =>
  useSuspenseQuery(projectQueries.skills(projectId));

export function usableAgents(overview: Awaited<ReturnType<typeof api.externalAgents>>) {
  return overview.agents
    .filter((agent) => !agent.shadowed && agent.state.status === "trusted")
    .map((agent) => agent.name);
}
