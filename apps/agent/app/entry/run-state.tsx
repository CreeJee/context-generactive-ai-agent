import type { SessionRunState } from "memory-agent/definitions";
import type { WorkflowPhase } from "./api";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { api, ApiError } from "./api";
import { noticeOf, type PageView, type RunNotice } from "./run-notice";

const pollMs = 2_000;

/**
 * The server's view of a session's runs: refreshed whenever the page stops generating, so a run
 * that was cancelled, cut off by a restart, or is still going without this page is reported from
 * the record rather than guessed. While such a run goes on, it is checked again until it ends.
 */
export function useRunState(
  sessionId: string,
  holder: string,
  generating: boolean,
  page: PageView,
) {
  const [state, setState] = useState<SessionRunState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Asked to stop, but the server had not confirmed it by the time it answered.
  const [cancelPending, setCancelPending] = useState(false);
  const detached = !generating && state !== null && state.running !== null;

  useEffect(() => {
    if (generating) return;
    let current = true;
    const refresh = () =>
      api.sessionRunState(sessionId, holder).then(
        (next) => {
          if (!current) return;
          setState(next);
          if (next.running === null) setCancelPending(false);
        },
        () => {},
      );
    void refresh();
    const poll = cancelPending || detached ? setInterval(() => void refresh(), pollMs) : null;
    return () => {
      current = false;
      if (poll) clearInterval(poll);
    };
  }, [sessionId, holder, generating, cancelPending, detached]);

  /** Asks the server to stop the run. Resolves false when nothing could be asked (network error). */
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await api.cancelRun(sessionId, holder);
      setCancelPending(!result.stopped);
      return true;
    } catch (failure) {
      // 409: the server has nothing running any more, so there is only the local stream to end.
      return failure instanceof ApiError && failure.status === 409;
    } finally {
      setCancelling(false);
    }
  };

  const setWorkflowPhase = async (phase: WorkflowPhase) => {
    const workflow = await api.setWorkflowPhase(sessionId, holder, phase);
    setState((current) => (current ? { ...current, workflow } : current));
    return workflow;
  };

  return {
    cancelling,
    cancel,
    context: state?.context ?? null,
    workflow: state?.workflow ?? null,
    setWorkflowPhase,
    notice: cancelPending ? ({ kind: "cancel-pending" } as const) : noticeOf(state, page),
  };
}

export function RunNoticeView({ notice }: { notice: RunNotice }) {
  switch (notice.kind) {
    case "cancelled":
      return <p className="text-xs text-muted-foreground">답변을 멈췄어요.</p>;
    case "cancel-pending":
      return (
        <Alert>
          <AlertTitle>멈추기를 요청했어요</AlertTitle>
          <AlertDescription>
            서버에서 아직 멈추지 않았어요. 멈추면 여기에 표시돼요.
          </AlertDescription>
        </Alert>
      );
    case "restarted":
      return (
        <Alert>
          <AlertTitle>마지막 답변이 끝나지 않았어요</AlertTitle>
          <AlertDescription>
            답변 중에 서버가 다시 시작됐어요. 자동으로 다시 실행하지 않으니, 필요하면 다시 보내
            주세요.
          </AlertDescription>
        </Alert>
      );
    case "failed":
      return (
        <Alert variant="destructive">
          <AlertTitle>마지막 답변이 실패했어요</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      );
    case "detached":
      return (
        <Alert>
          <AlertTitle>답변이 아직 진행 중이에요</AlertTitle>
          <AlertDescription>
            이 페이지와 연결이 끊겼지만 서버에서는 계속 답하고 있어요. 다시 연결하면 이어서 볼 수
            있어요.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              <RefreshCwIcon /> 다시 연결
            </Button>
          </AlertAction>
        </Alert>
      );
    case "stopped":
      return (
        <Alert>
          <AlertTitle>답변이 중간에 멈췄어요</AlertTitle>
          <AlertDescription>끝까지 답하지 못했어요. 필요하면 다시 보내 주세요.</AlertDescription>
        </Alert>
      );
    case "no-answer":
      return (
        <Alert>
          <AlertTitle>답변 글 없이 끝났어요</AlertTitle>
          <AlertDescription>
            모델이 도구만 쓰고 답을 쓰지 않은 채 마쳤어요. &ldquo;이어서 답해 줘&rdquo;처럼 다시
            보내 주세요.
          </AlertDescription>
        </Alert>
      );
  }
}
