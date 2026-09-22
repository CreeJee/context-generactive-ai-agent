import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApprovalRequester, type RelayedApprovalView, type SubagentView } from "./api";
import { useSessionEventScope } from "./events/context";
import { appQueryKeys } from "./events/query-keys";

interface DelegatedState {
  readonly subagents: readonly SubagentView[];
  readonly approvals: readonly RelayedApprovalView[];
}

/** Subagent and relayed-approval snapshots, refreshed by their session SSE topics. */
export function useDelegatedWork(sessionId: string, _generating: boolean) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Delegated work requires an active project");
  const queryClient = useQueryClient();
  const subagentsKey = appQueryKeys.session.subagents(projectId, sessionId);
  const approvalsKey = appQueryKeys.session.approvals(projectId, sessionId);
  const subagents = useQuery({ queryKey: subagentsKey, queryFn: () => api.subagents(sessionId) });
  const approvals = useQuery({
    queryKey: approvalsKey,
    queryFn: () => api.relayedApprovals(sessionId),
  });
  const state: DelegatedState = {
    subagents: subagents.data ?? [],
    approvals: approvals.data ?? [],
  };
  const setState = (update: (current: DelegatedState) => DelegatedState) => {
    const next = update(state);
    queryClient.setQueryData(subagentsKey, next.subagents);
    queryClient.setQueryData(approvalsKey, next.approvals);
  };
  return { state, setState };
}

export function requesterLabel(requester: ApprovalRequester) {
  switch (requester.kind) {
    case "subagent":
      return requester.name ? `서브에이전트 ${requester.name}` : "서브에이전트";
    case "external_agent":
      return `외부 에이전트 ${requester.agent}`;
  }
}
