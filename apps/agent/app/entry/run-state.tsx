import { RefreshCwIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import type { RunNotice } from "./run-notice";

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
