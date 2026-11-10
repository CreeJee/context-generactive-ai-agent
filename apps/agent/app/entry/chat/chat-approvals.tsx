import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { runUiEffect, uiPromise } from "../shared/ui-effect";
import { Effect } from "effect";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { cn } from "cn";
import { api, isApiError } from "../api";
import { ApprovalCard } from "./approval";
import type { Refusal } from "memory-agent/chat-api";
import type { PendingApproval } from "./pending-approval";
import { refusalTexts } from "./refusals";
import { AnswerProblem } from "./use-agent-chat";

/**
 * A refused answer whose approvals are no longer the ones waiting: the server took it as a turn
 * with nothing to answer.
 */
const answersOutdated = (refusal: Refusal) =>
  refusal.error === "no_user_turn" || refusal.error === "empty_message";

/** What the alert says for each problem, and what its button does. */
const problems = {
  unsent: { text: msg`승인 응답을 전송하지 못했습니다.`, action: msg`응답 다시 보내기` },
  outdated: {
    text: msg`연결이 끊긴 사이 승인 목록이 바뀌었습니다. 서버의 최신 요청을 다시 불러와야 합니다.`,
    action: msg`최신 요청 불러오기`,
  },
  lost: {
    text: msg`승인한 뒤 실행을 이어가지 못했습니다. 요청을 폐기해도 셸 명령은 실행되지 않습니다. 대화와 작업 evidence는 유지됩니다.`,
    action: msg`끊어진 요청 폐기하고 계속`,
  },
} satisfies Record<
  "unsent" | "outdated" | "lost",
  { readonly text: MessageDescriptor; readonly action: MessageDescriptor }
>;

/** Answers the approvals a run waits for together, once every one has a decision. */
export function ChatApprovals({
  sessionId,
  holder,
  approvals,
  problem,
  readOnly,
  resuming,
  onResolve,
  onResync,
  onProblem,
}: {
  sessionId: string;
  holder: string;
  approvals: readonly PendingApproval[];
  problem: AnswerProblem | null;
  readOnly: boolean;
  resuming: boolean;
  onResolve: (decisions: Readonly<Record<string, boolean>>) => void;
  onResync: () => void;
  onProblem: (message: string) => void;
}) {
  const { t } = useLingui();
  const [decisions, setDecisions] = useState<Readonly<Record<string, boolean>>>({});
  const [discarding, trackDiscard] = useLoading();

  const answer = (id: string, approved: boolean) => {
    const next = { ...decisions, [id]: approved };
    setDecisions(next);
    if (approvals.every((approval) => next[approval.id] !== undefined)) onResolve(next);
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const discard = () =>
    runUiEffect(
      uiPromise(() => trackDiscard(api.discardInterrupts(sessionId, holder))).pipe(
        Effect.tap(() => Effect.sync(onResync)),
        Effect.catchTag("UnknownError", (failure) =>
          Effect.sync(() =>
            onProblem(
              isApiError(failure.cause) && failure.cause.code === "run_in_progress"
                ? t`실행 중인 응답이 끝난 뒤 다시 시도해 주십시오.`
                : t`끊어진 승인 요청을 폐기하지 못했습니다.`,
            ),
          ),
        ),
      ),
    );
  // A refusal for another reason says why in the refusal's words; reading the approvals again
  // shows what the server has now.
  const shown =
    problem === null
      ? null
      : AnswerProblem.$match(problem, {
          unsent: () => ({
            text: t(problems.unsent.text),
            action: t(problems.unsent.action),
            act: () => onResolve(decisions),
          }),
          refused: ({ refusal }) => ({
            text: t(
              answersOutdated(refusal) ? problems.outdated.text : refusalTexts[refusal.error],
            ),
            action: t(problems.outdated.action),
            act: onResync,
          }),
          lost: () => ({
            text: t(problems.lost.text),
            action: t(problems.lost.action),
            act: () => void discard(),
          }),
        });

  return (
    <>
      {shown !== null && (
        <Alert variant="destructive">
          <AlertTitle>
            <Trans>승인 요청을 이어가지 못했습니다</Trans>
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-col items-start gap-3">
              <p>{shown.text}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || resuming || discarding}
                onClick={shown.act}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", (resuming || discarding) && "animate-spin")}
                />
                {shown.action}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          decision={decisions[approval.id]}
          disabled={readOnly || resuming || problem !== null}
          onAnswer={(approved) => answer(approval.id, approved)}
        />
      ))}
    </>
  );
}
