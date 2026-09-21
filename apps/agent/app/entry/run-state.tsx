import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionRunState } from "memory-agent/definitions";
import type { WorkflowAction, WorkflowPhase } from "./api";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { api, ApiError } from "./api";
import { useSessionEventScope } from "./events/providers";
import { appQueryKeys } from "./events/query-keys";
import { noticeOf, type PageView, type RunNotice } from "./run-notice";

/** The authoritative durable run/workflow snapshot, refreshed by session SSE invalidations. */
export function useRunState(
  sessionId: string,
  holder: string,
  generating: boolean,
  page: PageView,
) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Run state requires an active project");
  const queryClient = useQueryClient();
  const queryKey = appQueryKeys.session.runState(projectId, sessionId);
  const query = useQuery({
    queryKey,
    queryFn: () => api.sessionRunState(sessionId, holder),
    enabled: !generating,
    staleTime: 0,
  });
  const state = query.data ?? null;
  const [cancelling, setCancelling] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const refresh = async () => {
    const result = await query.refetch();
    if (result.data?.running === null) setCancelPending(false);
    if (!result.data) throw new Error("Run state refresh returned no snapshot");
    return result.data;
  };

  /** Asks the server to stop the run. Resolves false when nothing could be asked (network error). */
  const cancel = async () => {
    setCancelling(true);
    try {
      const result = await api.cancelRun(sessionId, holder);
      setCancelPending(!result.stopped);
      await queryClient.invalidateQueries({ queryKey });
      return true;
    } catch (failure) {
      return failure instanceof ApiError && failure.status === 409;
    } finally {
      setCancelling(false);
    }
  };

  const setWorkflowPhase = async (phase: WorkflowPhase) => {
    const workflow = await api.setWorkflowPhase(sessionId, holder, phase);
    queryClient.setQueryData<SessionRunState>(queryKey, (current) =>
      current ? { ...current, workflow } : current,
    );
    return workflow;
  };

  const controlWorkflow = async (action: WorkflowAction) => {
    setControlling(true);
    try {
      const workflow = await api.controlWorkflow(sessionId, holder, action);
      queryClient.setQueryData<SessionRunState>(queryKey, (current) =>
        current ? { ...current, workflow } : current,
      );
      return workflow;
    } finally {
      setControlling(false);
    }
  };

  return {
    cancelling,
    controlling,
    cancel,
    controlWorkflow,
    refresh,
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
