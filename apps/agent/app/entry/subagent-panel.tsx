import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "~/components/ui/item";
import { Spinner } from "~/components/ui/spinner";
import { api, type ApprovalRequester, type RelayedApprovalView, type SubagentView } from "./api";
import { ApprovalCard, type PendingApproval } from "./approval";
import { useSessionEventScope } from "./events/providers";
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
      return requester.name ? `서브에이전트 ${requester.name}` : "일회 서브에이전트";
    case "external_agent":
      return `외부 에이전트 ${requester.agent}`;
  }
}

function toPending(
  approval: RelayedApprovalView,
  answer: (approved: boolean) => void,
): PendingApproval {
  return {
    kind: "permission-review",
    id: approval.id,
    toolCallId: approval.id,
    toolName: approval.toolName,
    argumentsJson: approval.argumentsJson,
    reviewReason: approval.reason,
    askedBy: approval.askedBy === "review" ? "review" : "every_call",
    answer,
  };
}

/** Active delegated work and permission calls relayed from it. */
export function SubagentPanel({
  sessionId,
  holder,
  generating,
  readOnly,
}: {
  sessionId: string;
  holder: string;
  generating: boolean;
  readOnly: boolean;
}) {
  const { state, setState } = useDelegatedWork(sessionId, generating);
  const running = state.subagents.filter((child) => child.status === "running");
  if (running.length === 0 && state.approvals.length === 0) return null;

  const answer = (approvalId: string, approved: boolean) =>
    void api
      .answerApproval(sessionId, holder, approvalId, approved)
      .then((approvals) => setState((current) => ({ ...current, approvals })))
      .catch(() => undefined);

  return (
    <div className="flex flex-col gap-3">
      {running.length > 0 && (
        <ItemGroup>
          {running.map((child) => (
            <Item key={child.id} variant="muted" size="sm">
              <ItemMedia variant="icon">
                <BotIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {requesterLabel({ kind: "subagent", subagentId: child.id, name: child.name })}
                  <Badge variant="secondary">
                    <Spinner /> 작업 중
                  </Badge>
                </ItemTitle>
                <ItemDescription>{child.lastTask}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {state.approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          requester={requesterLabel(approval.requester)}
          approval={toPending(approval, (approved) => answer(approval.id, approved))}
          disabled={readOnly}
        />
      ))}
    </div>
  );
}
