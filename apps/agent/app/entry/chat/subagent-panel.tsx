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
import { type RelayedApprovalView } from "../api";
import { ApprovalCard } from "./approval";
import { requesterLabel, useDelegatedWork } from "../session/delegated-work";
import { useSessionEventScope } from "../events/context";
import { useRelayedApprovalMutation } from "../queries/mutations/session";
import type { PendingApproval } from "./pending-approval";

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
  const { state } = useDelegatedWork(sessionId, generating);
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Relayed approval requires an active project");
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
