import { Data, Function as EffectFunction } from "effect";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ExternalAgentView, type McpScope } from "../../api";
import { projectQueries } from "../project";
import { globalQueries } from "../global";

export function useMcpTrustMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, name, trusted }: { scope: McpScope; name: string; trusted: boolean }) =>
      api.setMcpTrusted(projectId, scope, name, trusted),
    onSuccess: () => client.invalidateQueries({ queryKey: projectQueries.mcp(projectId).queryKey }),
  });
}

export function useProtectedBranchesMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (branches: readonly string[]) => api.setProtectedBranches(projectId, branches),
    onSuccess: (settings) =>
      client.setQueryData(projectQueries.kanban(projectId).queryKey, settings),
  });
}

/** Moves a conversation's Goal in the project's order; the board list carries the new places. */
export function useGoalOrderMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      before,
    }: {
      readonly sessionId: string;
      readonly before: string | null;
    }) => api.moveGoal(projectId, sessionId, before),
    onSuccess: (settings) =>
      client.setQueryData(projectQueries.kanban(projectId).queryKey, settings),
    onSettled: () =>
      client.invalidateQueries({ queryKey: projectQueries.boards(projectId).queryKey }),
  });
}

export type AgentChange = Data.TaggedEnum<{
  trust: {
    readonly scope: ExternalAgentView["scope"];
    readonly name: string;
    readonly trusted: boolean;
  };
  reconnect: { readonly name: string };
}>;
export const AgentChange = Data.taggedEnum<AgentChange>();

export function useExternalAgentMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: AgentChange.$match({
      trust: ({ scope, name, trusted }) => api.trustExternalAgent(projectId, scope, name, trusted),
      reconnect: ({ name }) => api.reconnectExternalAgent(projectId, name),
    }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.agents(projectId).queryKey }),
  });
}

export function usePermissionModeMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mode: Parameters<typeof api.setPermissionMode>[1]) =>
      api.setPermissionMode(projectId, mode),
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

export function useCrossRecallMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (excluded: boolean) => api.setCrossRecallExcluded(projectId, excluded),
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

export function useHideProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.hideProject,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

/** Archive release: the project is back in the list (and out of the archive). */
export function useRestoreProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.restoreProject,
    onSuccess: () => client.invalidateQueries({ queryKey: globalQueries.projects().queryKey }),
  });
}

export function useCreateSessionMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agent?: string) => api.createSession(projectId, agent),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}

/** What the sidebar asks of one conversation. */
export type SessionLifecycleChange = Data.TaggedEnum<{
  archive: { readonly sessionId: string };
  restore: { readonly sessionId: string };
  delete: { readonly sessionId: string };
}>;
export const SessionLifecycleChange = Data.taggedEnum<SessionLifecycleChange>();

export const useSessionLifecycleMutation: {
  (holder: () => string): (projectId: string) => ReturnType<typeof useSessionLifecycleMutationBody>;
} & typeof useSessionLifecycleMutationBody = EffectFunction.dual(
  2,
  useSessionLifecycleMutationBody,
);
function useSessionLifecycleMutationBody(projectId: string, holder: () => string) {
  const client = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof api.setArchived>> | Awaited<ReturnType<typeof api.deleteSession>>,
    Error,
    SessionLifecycleChange
  >({
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    mutationFn: SessionLifecycleChange.$match({
      archive: ({ sessionId }) => api.setArchived(sessionId, holder(), true),
      restore: ({ sessionId }) => api.setArchived(sessionId, holder(), false),
      delete: ({ sessionId }) => api.deleteSession(sessionId, holder()),
    }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}
