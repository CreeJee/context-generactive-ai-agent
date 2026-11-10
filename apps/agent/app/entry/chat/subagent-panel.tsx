import { Trans, useLingui } from "@lingui/react/macro";
import { BotIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { ApprovalRequester, refusalOf, type RelayedApprovalView } from "../api";
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
  const { t } = useLingui();
  const { state } = useDelegatedWork(sessionId, generating);
  const projectId = useProjectScope("relayed_approval");
  const answerMutation = useRelayedApprovalMutation(projectId, sessionId, holder);
  const running = state.subagents.filter((child) => child.status === "running");
  if (running.length === 0 && state.approvals.length === 0) return null;

  const answer = (approvalId: string, approved: boolean) =>
    answerMutation.mutate({ approvalId, approved });
  // The list is read again after a failed answer, so the alert says why and what is left.
  const refusal = refusalOf(answerMutation.error);
  const problem =
    answerMutation.error === null
      ? null
      : refusal?.code === "approval_not_pending"
        ? t`이미 답했거나 더 이상 기다리지 않는 요청입니다. 남은 요청을 다시 불러왔습니다.`
        : refusal?.code === "session_in_use"
          ? t`다른 창이 이 대화를 쓰고 있습니다.`
          : t`승인 응답을 전송하지 못했습니다.`;

  return (
    <div className="flex flex-col gap-3">
      {running.length > 0 && (
        <ItemGroup>
          {running.map((child) => (
            <Item key={child.id} variant="outline" size="sm">
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
                    <Spinner />{" "}
                    <Trans comment="Badge on a subagent that is still running">작업 중</Trans>
                  </Badge>
                </ItemTitle>
                <ItemDescription>{child.lastTask}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTitle>
            <Trans>승인 요청을 이어가지 못했습니다</Trans>
          </AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {state.approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          requester={requesterLabel(approval.requester)}
          approval={toPending(approval)}
          disabled={readOnly || answerMutation.isPending}
          onAnswer={(approved) => answer(approval.id, approved)}
        />
      ))}
    </div>
  );
}
