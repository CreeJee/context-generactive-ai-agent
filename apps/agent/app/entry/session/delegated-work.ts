import { isTruthy } from "../../truthy.ts";
import { type ApprovalRequester, type RelayedApprovalView, type SubagentView } from "../api";
import { useSessionEventScope } from "../events/context";
import { useApprovalsQuery, useSubagentsQuery } from "../queries/session";

interface DelegatedState {
  readonly subagents: readonly SubagentView[];
  readonly approvals: readonly RelayedApprovalView[];
}

/** Subagent and relayed-approval snapshots, refreshed by their session SSE topics. */
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function useDelegatedWork(sessionId: string, _generating: boolean) {
  const { projectId } = useSessionEventScope();
  if (!isTruthy(projectId)) throw new Error("Delegated work requires an active project");
  const subagents = useSubagentsQuery(projectId, sessionId);
  const approvals = useApprovalsQuery(projectId, sessionId);
  const state: DelegatedState = {
    subagents: subagents.data ?? [],
    approvals: approvals.data ?? [],
  };
  return { state };
}

export function requesterLabel(requester: ApprovalRequester) {
  switch (requester.kind) {
    case "subagent":
      return isTruthy(requester.name) ? `서브에이전트 ${requester.name}` : "서브에이전트";
    case "external_agent":
      return `외부 에이전트 ${requester.agent}`;
  }
}
