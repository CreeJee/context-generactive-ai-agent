import { serverRestartedCode, type SessionRunState } from "memory-agent/definitions";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { api, ApiError } from "./api";

/** How a session's last run ended, when that is worth telling the user. */
export type RunNotice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "cancel-pending" }
  | { readonly kind: "restarted" }
  | { readonly kind: "failed"; readonly message: string };

const pollWhilePendingMs = 2_000;

function noticeOf(lastRun: SessionRunState["lastRun"]): RunNotice | null {
  if (!lastRun) return null;
  switch (lastRun.status) {
    case "aborted":
      return { kind: "cancelled" };
    case "failed":
      return lastRun.error?.code === serverRestartedCode
        ? { kind: "restarted" }
        : { kind: "failed", message: lastRun.error?.message ?? "알 수 없는 오류" };
    case "running":
    case "interrupted":
    case "completed":
      return null;
  }
}

/**
 * The server's view of a session's runs: refreshed whenever the page stops generating, so a run
 * that was cancelled, or cut off by a restart, is reported from the record rather than guessed.
 */
export function useRunState(sessionId: string, generating: boolean) {
  const [state, setState] = useState<SessionRunState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Asked to stop, but the server had not confirmed it by the time it answered.
  const [cancelPending, setCancelPending] = useState(false);

  useEffect(() => {
    if (generating) return;
    let current = true;
    const refresh = () =>
      api.sessionRunState(sessionId).then(
        (next) => {
          if (!current) return;
          setState(next);
          if (next.running === null) setCancelPending(false);
        },
        () => {},
      );
    void refresh();
    const poll = cancelPending ? setInterval(() => void refresh(), pollWhilePendingMs) : null;
    return () => {
      current = false;
      if (poll) clearInterval(poll);
    };
  }, [sessionId, generating, cancelPending]);

  /** Asks the server to stop the run. Resolves false when nothing could be asked (network error). */
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await api.cancelRun(sessionId);
      setCancelPending(!result.stopped);
      return true;
    } catch (failure) {
      // 409: the server has nothing running any more, so there is only the local stream to end.
      return failure instanceof ApiError && failure.status === 409;
    } finally {
      setCancelling(false);
    }
  };

  return {
    cancelling,
    cancel,
    notice: cancelPending
      ? ({ kind: "cancel-pending" } as const)
      : noticeOf(state?.lastRun ?? null),
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
  }
}
