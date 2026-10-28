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
import { ApprovalRequester, type RelayedApprovalView } from "../api";
import { ApprovalCard } from "./approval";
import { requesterLabel, useDelegatedWork } from "../session/delegated-work";
import { useProjectScope } from "../events/context";
import { useRelayedApprovalMutation } from "../queries/mutations/session";
import { PendingApproval } from "./pending-approval";

function toPending(approval: RelayedApprovalView): PendingApproval {
  return PendingApproval["permission-review"]({
    id: approval.id,
    toolCallId: approval.id,
    toolName: approval.toolName,
    argumentsJson: approval.argumentsJson,
    reviewReason: approval.reason,
    askedBy: approval.askedBy === "review" ? "review" : "every_call",
  });
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
  const { state } = useDelegatedWork(sessionId, generating);
  const projectId = useProjectScope("relayed_approval");
  const answerMutation = useRelayedApprovalMutation(projectId, sessionId, holder);
  const running = state.subagents.filter((child) => child.status === "running");
  if (running.length === 0 && state.approvals.length === 0) return null;

  const answer = (approvalId: string, approved: boolean) =>
    void answerMutation.mutateAsync({ approvalId, approved }).catch(() => undefined);

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
                  {requesterLabel(
                    ApprovalRequester.cases.subagent.make({
                      subagentId: child.id,
                      name: child.name,
                    }),
                  )}
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
          approval={toPending(approval)}
          disabled={readOnly}
          onAnswer={(approved) => answer(approval.id, approved)}
        />
      ))}
    </div>
  );
}
