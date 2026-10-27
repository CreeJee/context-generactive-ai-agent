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
import type { PendingApproval } from "./pending-approval";
import type { AnswerProblem } from "./use-agent-chat";

/** What the alert says for each problem, and what its button does. */
const problems = {
  unsent: { text: "승인 응답을 전송하지 못했어요.", action: "응답 다시 보내기" },
  refused: {
    text: "연결이 끊긴 사이 승인 목록이 바뀌었어요. 서버의 최신 요청을 다시 불러와야 해요.",
    action: "최신 요청 불러오기",
  },
  lost: {
    text: "승인한 뒤 실행을 이어가지 못했어요. 요청을 폐기해도 셸 명령은 실행되지 않으며, 대화와 작업 evidence는 유지돼요.",
    action: "끊어진 요청 폐기하고 계속",
  },
} satisfies Record<AnswerProblem, { readonly text: string; readonly action: string }>;

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
                ? "실행 중인 응답이 끝난 뒤 다시 시도해 주세요."
                : "끊어진 승인 요청을 폐기하지 못했어요.",
            ),
          ),
        ),
      ),
    );
  const actions = {
    unsent: () => onResolve(decisions),
    refused: onResync,
    lost: () => void discard(),
  } satisfies Record<AnswerProblem, () => void>;

  return (
    <>
      {problem !== null && (
        <Alert variant="destructive">
          <AlertTitle>승인 요청을 이어가지 못했어요</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col items-start gap-3">
              <p>{problems[problem].text}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || resuming || discarding}
                onClick={actions[problem]}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", (resuming || discarding) && "animate-spin")}
                />
                {problems[problem].action}
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
