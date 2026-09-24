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

type AgentChange =
  | {
      readonly kind: "trust";
      readonly scope: ExternalAgentView["scope"];
      readonly name: string;
      readonly trusted: boolean;
    }
  | { readonly kind: "reconnect"; readonly name: string };

export function useExternalAgentMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: AgentChange) => {
      switch (change.kind) {
        case "trust":
          return api.trustExternalAgent(projectId, change.scope, change.name, change.trusted);
        case "reconnect":
          return api.reconnectExternalAgent(projectId, change.name);
      }
    },
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

export function useCreateSessionMutation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agent?: string) => api.createSession(projectId, agent),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}

export function useSessionLifecycleMutation(projectId: string, holder: () => string) {
  const client = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof api.setArchived>> | Awaited<ReturnType<typeof api.deleteSession>>,
    Error,
    { kind: "archive" | "restore" | "delete"; sessionId: string }
  >({
    mutationFn: async (request) => {
      switch (request.kind) {
        case "archive":
          return api.setArchived(request.sessionId, holder(), true);
        case "restore":
          return api.setArchived(request.sessionId, holder(), false);
        case "delete":
          return api.deleteSession(request.sessionId, holder());
      }
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: projectQueries.sessions(projectId).queryKey }),
  });
}
