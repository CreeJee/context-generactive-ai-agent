import { BotIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

/** While a run answers, delegated work is checked this often for progress and approval requests. */
const pollMs = 1_500;

interface DelegatedState {
  readonly subagents: readonly SubagentView[];
  readonly approvals: readonly RelayedApprovalView[];
}

const empty: DelegatedState = { subagents: [], approvals: [] };

/**
 * Subagents of the session and calls waiting for the user from work that cannot pause the run
 * (subagents, external agents). Refreshed when the run starts or stops and polled while it runs.
 */
export function useDelegatedWork(sessionId: string, generating: boolean) {
  const [state, setState] = useState<DelegatedState>(empty);

  const refresh = useCallback(
    () =>
      Promise.all([api.subagents(sessionId), api.relayedApprovals(sessionId)]).then(
        ([subagents, approvals]) => setState({ subagents, approvals }),
        () => undefined,
      ),
    [sessionId],
  );

  useEffect(() => {
    void refresh();
    if (!generating) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, generating]);

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

/**
 * Subagents working right now, and calls waiting for the user that could not pause the run. They
 * are answered here while the run keeps going.
 */
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
        <ItemGroup className="gap-2">
          {running.map((child) => (
            <Item key={child.id} variant="muted" size="sm">
              <ItemMedia variant="icon">
                <BotIcon />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="flex items-center gap-1.5">
                  {requesterLabel({ kind: "subagent", subagentId: child.id, name: child.name })}
                  <Badge variant="secondary">
                    <Spinner /> 작업 중
                  </Badge>
                </ItemTitle>
                <ItemDescription className="line-clamp-2">{child.lastTask}</ItemDescription>
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
