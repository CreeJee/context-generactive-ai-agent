import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useLoading } from "react-simplikit";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { cn } from "cn";
import { api, ApiError } from "../api";
import { ApprovalCard } from "./approval";
import type { PendingApproval } from "./pending-approval";

/** Answers one interrupt batch atomically and owns only that batch's pending decisions. */
export function ChatApprovals({
  sessionId,
  holder,
  approvals,
  incomplete,
  stale,
  retryable,
  continuationLost,
  errorCount,
  errorMessage,
  readOnly,
  resuming,
  onResolve,
  onRetry,
  onResync,
  onProblem,
}: {
  sessionId: string;
  holder: string;
  approvals: readonly PendingApproval[];
  incomplete: boolean;
  stale: boolean;
  retryable: boolean;
  continuationLost: boolean;
  errorCount: number;
  errorMessage: string | null;
  readOnly: boolean;
  resuming: boolean;
  onResolve: (decisions: Readonly<Record<string, boolean>>) => void;
  onRetry: () => void;
  onResync: () => void;
  onProblem: (message: string) => void;
}) {
  const [decisions, setDecisions] = useState<Readonly<Record<string, boolean>>>({});
  const [discarding, trackDiscard] = useLoading();

  const answer = (id: string, approved: boolean) => {
    const next = { ...decisions, [id]: approved };
    setDecisions(next);
    if (incomplete || stale || approvals.some((approval) => next[approval.id] === undefined))
      return;
    try {
      onResolve(next);
    } catch {
      onProblem("승인 응답을 준비하지 못했어요. 서버 상태를 다시 불러와 주세요.");
    }
  };

  const discard = async () => {
    try {
      await trackDiscard(api.discardInterrupts(sessionId, holder));
      onResync();
    } catch (failure) {
      onProblem(
        failure instanceof ApiError && failure.code === "run_in_progress"
          ? "실행 중인 응답이 끝난 뒤 다시 시도해 주세요."
          : "끊어진 승인 요청을 폐기하지 못했어요.",
      );
    }
  };

  return (
    <>
      {(incomplete || errorCount > 0 || continuationLost) && (
        <Alert variant="destructive">
          <AlertTitle>승인 요청을 이어가지 못했어요</AlertTitle>
          <AlertDescription>
            <div className="flex flex-col items-start gap-3">
              <p>
                {continuationLost
                  ? "서버에 이 승인 요청을 이어갈 실행 상태가 남아 있지 않아요. 요청을 폐기해도 셸 명령은 실행되지 않으며, 대화와 작업 evidence는 유지돼요."
                  : stale || incomplete
                    ? "연결이 끊긴 사이 승인 목록이 바뀌었어요. 서버의 최신 요청을 다시 불러와야 해요."
                    : (errorMessage ?? "승인 응답을 전송하지 못했어요.")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || resuming || discarding}
                onClick={
                  continuationLost ? () => void discard() : retryable && !stale ? onRetry : onResync
                }
              >
                <RefreshCwIcon
                  className={cn("size-3.5", (resuming || discarding) && "animate-spin")}
                />
                {continuationLost
                  ? "끊어진 요청 폐기하고 계속"
                  : retryable && !stale
                    ? "응답 다시 보내기"
                    : "최신 요청 불러오기"}
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
          disabled={readOnly || resuming || incomplete || stale || retryable || continuationLost}
          onAnswer={(approved) => answer(approval.id, approved)}
        />
      ))}
    </>
  );
}
