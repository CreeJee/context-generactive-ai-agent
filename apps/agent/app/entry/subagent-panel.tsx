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
import { api, type SubagentApprovalView, type SubagentsState } from "./api";
import { ApprovalCard, type PendingApproval } from "./approval";

/** While a run answers, subagents are checked this often for progress and approval requests. */
const pollMs = 1_500;

const empty: SubagentsState = { subagents: [], approvals: [] };

/** The session's subagents (R18), refreshed when the run starts or stops and polled while it runs. */
export function useSubagents(sessionId: string, generating: boolean) {
  const [state, setState] = useState<SubagentsState>(empty);

  const refresh = useCallback(
    () =>
      api.subagents(sessionId).then(
        (next) => setState(next),
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

  return { state, refresh, setState };
}

const agentLabel = (name: string | null) => (name ? `서브에이전트 ${name}` : "일회 서브에이전트");

function toPending(
  approval: SubagentApprovalView,
  answer: (approved: boolean) => void,
): PendingApproval {
  return {
    kind: "permission-review",
    id: approval.id,
    toolCallId: approval.id,
    toolName: approval.toolName,
    argumentsJson: approval.argumentsJson,
    reviewReason: approval.reason,
    askedBy: approval.askedBy,
    answer,
  };
}

/**
 * Subagents working right now, and their calls waiting for the user. A child cannot pause the
 * parent run, so its approval requests are answered here while the run keeps going.
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
  const { state, setState } = useSubagents(sessionId, generating);
  const running = state.subagents.filter((child) => child.status === "running");
  if (running.length === 0 && state.approvals.length === 0) return null;

  const answer = (approvalId: string, approved: boolean) =>
    void api
      .answerSubagent(sessionId, holder, approvalId, approved)
      .then(setState)
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
                  {agentLabel(child.name)}
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
          requester={agentLabel(approval.agent)}
          approval={toPending(approval, (approved) => answer(approval.id, approved))}
          disabled={readOnly}
        />
      ))}
    </div>
  );
}
