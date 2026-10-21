import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect, Function as EffectFunction } from "effect";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { AgentTrustState, api } from "../api";
import { appQueryKeys } from "./keys";

export const projectQueries = {
  sessions: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.sessions(projectId),
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      queryFn: () =>
        runUiEffect(
          Effect.gen(function* () {
            const active = yield* uiPromise(() => api.sessions(projectId));
            const archived = yield* uiPromise(() => api.archivedSessions(projectId));
            return { active, archived };
          }),
        ),
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
  decisions: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.decisions(projectId),
      queryFn: () => api.decisionInbox(projectId),
      staleTime: 0,
    }),
  boards: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.boards(projectId),
      queryFn: () => api.projectBoards(projectId),
      staleTime: 0,
    }),
  traceTask: (projectId: string, taskId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.traceTask(projectId, taskId),
      queryFn: () => api.projectWorkTraceTask(projectId, taskId),
    }),
  kanban: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.kanban(projectId),
      queryFn: () => api.projectKanban(projectId),
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
export const useDecisionInboxQuery = (projectId: string) =>
  useQuery(projectQueries.decisions(projectId));
export const useProjectBoardsQuery = (projectId: string) =>
  useQuery(projectQueries.boards(projectId));
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
export const useSuspenseProjectKanbanQuery = (projectId: string) =>
  useSuspenseQuery(projectQueries.kanban(projectId));

export function usableAgents(overview: Awaited<ReturnType<typeof api.externalAgents>>) {
  return overview.agents
    .filter((agent) => !agent.shadowed && AgentTrustState.$is("trusted")(agent.state))
    .map((agent) => agent.name);
}
