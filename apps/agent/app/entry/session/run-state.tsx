import { RefreshCwIcon } from "lucide-react";
import { runFailureText } from "memory-agent/definitions";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Marker, MarkerContent } from "~/components/ui/marker";
import { FailureDetails } from "../shared/failure-details";
import { koreanLocalTime } from "../shared/local-time";
import { sessionCopy } from "./copy";
import { RunNotice } from "./run-notice";

const copy = sessionCopy.runNotice;

export function RunNoticeView({ notice }: { notice: RunNotice }) {
  return RunNotice.$match(notice, {
    cancelled: () => (
      <Marker>
        <MarkerContent>{copy.cancelled}</MarkerContent>
      </Marker>
    ),
    "cancel-pending": () => (
      <Alert>
        <AlertTitle>{copy.cancelPending.title}</AlertTitle>
        <AlertDescription>{copy.cancelPending.body}</AlertDescription>
      </Alert>
    ),
    restarted: () => (
      <Alert>
        <AlertTitle>{copy.restarted.title}</AlertTitle>
        <AlertDescription>{copy.restarted.body}</AlertDescription>
      </Alert>
    ),
    resuming: ({ at }) => (
      <Alert>
        <AlertTitle>{copy.resuming.title}</AlertTitle>
        <AlertDescription>{copy.resuming.body(koreanLocalTime(at))}</AlertDescription>
      </Alert>
    ),
    failed: ({ message, code }) => (
      <Alert variant="destructive">
        <AlertTitle>{copy.failed.title}</AlertTitle>
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
        <AlertTitle>{copy.detached.title}</AlertTitle>
        <AlertDescription>{copy.detached.body}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCwIcon /> {copy.detached.reconnect}
          </Button>
        </AlertAction>
      </Alert>
    ),
    stopped: () => (
      <Alert>
        <AlertTitle>{copy.stopped.title}</AlertTitle>
        <AlertDescription>{copy.stopped.body}</AlertDescription>
      </Alert>
    ),
    "no-answer": () => (
      <Alert>
        <AlertTitle>{copy.noAnswer.title}</AlertTitle>
        <AlertDescription>{copy.noAnswer.body}</AlertDescription>
      </Alert>
    ),
    reconciled: () => (
      <Alert>
        <AlertTitle>{copy.reconciled.title}</AlertTitle>
        <AlertDescription>{copy.reconciled.body}</AlertDescription>
      </Alert>
    ),
  });
}
