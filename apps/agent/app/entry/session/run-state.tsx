import { Trans } from "@lingui/react/macro";
import { RefreshCwIcon } from "lucide-react";
import { runFailureText } from "memory-agent/definitions";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Marker, MarkerContent } from "~/components/ui/marker";
import { FailureDetails } from "../shared/failure-details";
import { koreanLocalTime } from "../shared/local-time";
import { RunNotice } from "./run-notice";

export function RunNoticeView({ notice }: { notice: RunNotice }) {
  return RunNotice.$match(notice, {
    cancelled: () => (
      <Marker>
        <MarkerContent>
          <Trans>답변을 멈췄습니다.</Trans>
        </MarkerContent>
      </Marker>
    ),
    "cancel-pending": () => (
      <Alert>
        <AlertTitle>
          <Trans>멈추기를 요청했습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>서버에서 아직 멈추지 않았습니다. 멈추면 여기에 표시됩니다.</Trans>
        </AlertDescription>
      </Alert>
    ),
    restarted: () => (
      <Alert>
        <AlertTitle>
          <Trans>마지막 답변이 끝나지 않았습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            답변 중에 서버가 다시 시작됐습니다. 자동으로 다시 실행하지 않습니다. 필요하면 다시 보내
            주십시오.
          </Trans>
        </AlertDescription>
      </Alert>
    ),
    resuming: ({ at }) => {
      const resumeAt = koreanLocalTime(at);
      return (
        <Alert>
          <AlertTitle>
            <Trans>마지막 답변이 끝나지 않았습니다</Trans>
          </AlertTitle>
          <AlertDescription>
            <Trans comment="{resumeAt} is the local time the new run starts">
              답변 중에 서버가 다시 시작됐습니다. 도구를 실행하기 전이라 같은 요청을 {resumeAt}에 새
              실행으로 이어서 진행합니다.
            </Trans>
          </AlertDescription>
        </Alert>
      );
    },
    failed: ({ message, code }) => (
      <Alert variant="destructive">
        <AlertTitle>
          <Trans>마지막 답변이 실패했습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          {code === "run_failed" ? (
            message
          ) : (
            <>
              <p>{runFailureText[code]}</p>
              <FailureDetails detail={message} />
            </>
          )}
        </AlertDescription>
      </Alert>
    ),
    detached: () => (
      <Alert>
        <AlertTitle>
          <Trans>답변이 아직 진행 중입니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            이 페이지와 연결이 끊겼지만 서버에서는 계속 답하고 있습니다. 다시 연결하면 이어서 볼 수
            있습니다.
          </Trans>
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCwIcon />{" "}
            <Trans comment="Button that reloads the page to receive the running answer again">
              다시 연결
            </Trans>
          </Button>
        </AlertAction>
      </Alert>
    ),
    stopped: () => (
      <Alert>
        <AlertTitle>
          <Trans>답변이 중간에 멈췄습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>끝까지 답하지 못했습니다. 필요하면 다시 보내 주십시오.</Trans>
        </AlertDescription>
      </Alert>
    ),
    "no-answer": () => (
      <Alert>
        <AlertTitle>
          <Trans>답변 글 없이 끝났습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            모델이 도구만 쓰고 답을 쓰지 않은 채 마쳤습니다. 이어서 답해 달라고 다시 보내 주십시오.
          </Trans>
        </AlertDescription>
      </Alert>
    ),
    reconciled: () => (
      <Alert>
        <AlertTitle>
          <Trans>앱이 상태를 고쳤습니다</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            이전 버전이 끝내지 못한 Goal 상태를 고치고 자동 실행을 멈췄습니다. 이어서 하려면
            메시지를 보내 주십시오.
          </Trans>
        </AlertDescription>
      </Alert>
    ),
  });
}
