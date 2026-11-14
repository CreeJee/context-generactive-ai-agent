import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect, Function as EffectFunction, Iterable } from "effect";
import { queryOptions, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Session } from "../api";
import { AgentTrustState, McpServerState, api } from "../api";
import { appQueryKeys } from "./keys";

/** Reads the project's conversations at work now (answering or running its board). */
const runningOptions = (projectId: string) =>
  queryOptions({
    queryKey: appQueryKeys.project.running(projectId),
    queryFn: () => api.runningSessions(projectId),
  });

export const projectQueries = {
  sessions: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.sessions(projectId),
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      queryFn: () =>
        runUiEffect(
          Effect.all(
            {
              active: uiPromise(() => api.sessions(projectId)),
              archived: uiPromise(() => api.archivedSessions(projectId)),
            },
            { concurrency: "unbounded" },
          ),
        ),
    }),
  mcp: (projectId: string) =>
    queryOptions({
      queryKey: appQueryKeys.project.mcp(projectId),
      queryFn: () => api.mcpServers(projectId),
      // Follow a login waiting in the browser; otherwise the page only changes when the user acts.
      refetchInterval: (query) =>
        query.state.data?.servers.some((server) =>
          McpServerState.$is("loggingIn")(server.state),
        ) === true
          ? 2000
          : false,
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
  running: runningOptions,
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

/** What the sidebar needs to name one project's group and fill it. */
export type ProjectSessions = {
  readonly projectId: string;
  readonly name: string;
  readonly sessions: ReadonlyArray<Session>;
  readonly archived: ReadonlyArray<Session>;
};

/** One project's conversations at work now, as its group orders and badges them. */
export type ProjectWorking = {
  readonly projectId: string;
  /** The project's conversations whose run is producing an answer now. */
  readonly answering: ReadonlySet<string>;
  /** The project's conversations whose kanban board is running. */
  readonly boardRunning: ReadonlySet<string>;
};

/** Follow a run only while this read's own project shows one under way. */
const followRunning = (query: { readonly state: { readonly data?: ReadonlyArray<string> } }) =>
  (query.state.data?.length ?? 0) > 0 ? 2000 : false;

/** Follow a run only while this project has a board running its kanban loop. */
const followBoards = (query: {
  readonly state: { readonly data?: ReadonlyArray<{ readonly kanbanActive: boolean }> };
}) => (query.state.data?.some((board) => board.kanbanActive) === true ? 2000 : false);

/**
 * The sidebar's groups read every listed project's conversations, not only the selected one's.
 * Each project's read keeps its own `appQueryKeys.project.sessions` key, so events and
 * lifecycle mutations keep invalidating exactly the projects they touched. A project whose read
 * is still under way contributes no group; the caller totals the misses for its loading and
 * failure states. The caller also decides which groups are worth showing: a project without
 * conversations is only the selected project's group, so the others leave the list to it.
 */
export function useAllProjectSessions(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyArray<ProjectSessions> {
  const reads = useQueries({
    queries: projects.map((project) => projectQueries.sessions(project.id)),
  });
  return projects.flatMap((project, index): Array<ProjectSessions> => {
    const read = reads[index];
    // A read still under way or failed contributes nothing; its group just does not exist yet.
    if (read === undefined || !read.isSuccess || read.data === undefined) return [];
    return [
      {
        projectId: project.id,
        name: project.name,
        sessions: read.data.active,
        archived: read.data.archived,
      },
    ];
  });
}

/**
 * Conversations at work now, across every listed project: answering, or running their board.
 * They lead their project's group in the sidebar and fill its header badge.
 *
 * The reads reuse the existing `running` and `boards` query keys and queries, so the page in use
 * shares the cache and the same SSE invalidations move every project's read. The two options
 * differ in what their data says, so the polling reads its own query's data type: a project with
 * nothing at work stops polling and follows only its events.
 */
export function useAllWorkingSessions(
  projects: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<ProjectWorking> {
  const answering = useQueries({
    queries: projects.map((project) => ({
      ...projectQueries.running(project.id),
      refetchInterval: followRunning,
    })),
  });
  const boards = useQueries({
    queries: projects.map((project) => ({
      ...projectQueries.boards(project.id),
      refetchInterval: followBoards,
    })),
  });
  return projects.map((project, index): ProjectWorking => {
    const boardRows = boards[index]?.data ?? [];
    return {
      projectId: project.id,
      answering: new Set(answering[index]?.data ?? []),
      boardRunning: new Set(
        Iterable.map(
          Iterable.filter(boardRows, (board) => board.kanbanActive),
          (board) => board.sessionId,
        ),
      ),
    };
  });
}

/** One project's cards waiting for a person: decisions to answer and added cards to approve. */
export type ProjectWaiting = {
  readonly projectId: string;
  readonly name: string;
  readonly decisions: Awaited<ReturnType<typeof api.decisionInbox>>;
  readonly boards: Awaited<ReturnType<typeof api.projectBoards>>;
};

/**
 * Cards waiting for a person, across every listed project. The reads keep each project's own
 * `decisions` and `boards` keys, so events still refresh only the project they touched.
 */
export function useAllWaitingDecisions(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) {
  const decisions = useQueries({
    queries: projects.map((project) => projectQueries.decisions(project.id)),
  });
  const boards = useQueries({
    queries: projects.map((project) => projectQueries.boards(project.id)),
  });
  return {
    waiting: projects.map((project, index): ProjectWaiting => ({
      projectId: project.id,
      name: project.name,
      decisions: decisions[index]?.data ?? [],
      boards: boards[index]?.data ?? [],
    })),
    /** Some read failed: a list that did not load is not an empty one. */
    failed: decisions.some((read) => read.isError) || boards.some((read) => read.isError),
    refetch: () => {
      decisions.forEach((read) => void read.refetch());
      boards.forEach((read) => void read.refetch());
    },
  };
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
// No server event follows MCP servers, agents or skills (their files and connections change on
// their own), so each settings page reads them again when it opens, showing the cached list first.
export const useSuspenseMcpQuery = (projectId: string) =>
  useSuspenseQuery({ ...projectQueries.mcp(projectId), refetchOnMount: "always" });
export const useSuspenseAgentsQuery = (projectId: string) =>
  useSuspenseQuery({ ...projectQueries.agents(projectId), refetchOnMount: "always" });
export const useSuspenseSkillsQuery = (projectId: string) =>
  useSuspenseQuery({ ...projectQueries.skills(projectId), refetchOnMount: "always" });
export const useSuspenseProjectKanbanQuery = (projectId: string) =>
  useSuspenseQuery(projectQueries.kanban(projectId));

export function usableAgents(overview: Awaited<ReturnType<typeof api.externalAgents>>) {
  return overview.agents
    .filter((agent) => !agent.shadowed && AgentTrustState.$is("trusted")(agent.state))
    .map((agent) => agent.name);
}
