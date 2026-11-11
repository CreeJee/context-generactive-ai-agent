import { isTruthy } from "../../truthy.ts";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useBackendRestartRequired } from "../shared/use-backend-restart";
import { EventConnectionContext, SessionEventScopeContext, useEventConnection } from "./context";
import { appEvents, type EventConnection, type NextAttempt } from "./event-source";
import { createEventInvalidator } from "./invalidation";
import { appQueryKeys } from "./query-keys";

function useScopedEvents(
  url: string | null,
  readyKey: readonly unknown[],
  onStatus: (state: EventConnection) => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isTruthy(url)) return;
    const invalidations = createEventInvalidator(
      (queryKey) => void queryClient.invalidateQueries({ queryKey }),
      readyKey,
    );
    const stop = new AbortController();
    Effect.runFork(
      appEvents({
        url,
        onChanged: (event) => invalidations.changed(event),
        onReady: (event) => invalidations.ready(event.revision),
        onStatus,
      }),
      { signal: stop.signal },
    );
    return () => stop.abort();
  }, [onStatus, queryClient, readyKey, url]);
}

/**
 * Says the live updates stopped while the stream is tried again: until then views do not change by
 * themselves. After 30 s without a stream it says the server cannot be reached, when the next try
 * starts, and lets the user try at once. Once it is back, its ready event refreshes what was
 * missed. A required restart has its own banner, which asks for a reload instead.
 */
function ReconnectingBanner() {
  const connection = useEventConnection();
  const restartRequired = useBackendRestartRequired();
  if (restartRequired) return null;
  switch (connection._tag) {
    case "connecting":
    case "live":
      return null;
    case "reconnecting":
      return (
        <Banner>
          <Spinner aria-hidden />
          <p role="status">
            <Trans>
              서버와 연결이 끊겨 다시 연결하는 중입니다. 그동안 화면이 최신 상태가 아닐 수 있습니다.
            </Trans>
          </p>
        </Banner>
      );
    case "unreachable":
      return (
        <Banner>
          <p role="status">
            <Trans>서버에 연결할 수 없습니다. 앱이 실행 중인지 확인해 주십시오.</Trans>
          </p>
          <NextAttemptControls nextAttempt={connection.nextAttempt} />
        </Banner>
      );
  }
}

function NextAttemptControls({ nextAttempt }: { readonly nextAttempt: NextAttempt }) {
  switch (nextAttempt._tag) {
    case "waiting": {
      const { seconds } = nextAttempt;
      return (
        <>
          <span className="text-muted-foreground">
            <Trans comment="When the app tries to reach the server again">
              다음 시도 {seconds}초 뒤
            </Trans>
          </span>
          <Button size="sm" variant="outline" onClick={nextAttempt.reconnectNow}>
            <Trans>지금 다시 연결</Trans>
          </Button>
        </>
      );
    }
    case "trying":
      return (
        <span className="text-muted-foreground">
          <Trans comment="The app is trying to reach the server right now">다시 연결하는 중…</Trans>
        </span>
      );
  }
}

function Banner({ children }: PropsWithChildren) {
  return (
    <div className="fixed inset-x-0 top-0 z-100 flex flex-wrap items-center justify-center gap-2 border-b border-warning/40 bg-background px-4 py-2 text-sm text-foreground shadow-sm">
      {children}
    </div>
  );
}

/** One stream carries global, project, and session invalidations. */
export function AppEventsProvider({ children }: PropsWithChildren) {
  const [connection, setConnection] = useState<EventConnection>({ _tag: "connecting" });
  useScopedEvents("/api/events", appQueryKeys.root, setConnection);
  return (
    <EventConnectionContext value={connection}>
      <ReconnectingBanner />
      {children}
    </EventConnectionContext>
  );
}

export function SessionEventsProvider({
  projectId,
  sessionId,
  children,
}: PropsWithChildren<{ readonly projectId: string | null; readonly sessionId: string | null }>) {
  return (
    <SessionEventScopeContext value={{ projectId, sessionId }}>{children}</SessionEventScopeContext>
  );
}
