import { isTruthy } from "../../truthy.ts";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Spinner } from "~/components/ui/spinner";
import { useBackendRestartRequired } from "../shared/use-backend-restart";
import { EventConnectionContext, SessionEventScopeContext, useEventConnection } from "./context";
import { connectAppEvents, type EventConnectionState } from "./event-source";
import { createEventInvalidator } from "./invalidation";
import { appQueryKeys } from "./query-keys";

function useScopedEvents(
  url: string | null,
  readyKey: readonly unknown[],
  onStatus?: (state: EventConnectionState) => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isTruthy(url)) return;
    const invalidations = createEventInvalidator(
      (queryKey) => void queryClient.invalidateQueries({ queryKey }),
      readyKey,
    );
    let disconnect: (() => void) | null = null;
    const visibilityChanged = () => {
      disconnect?.();
      disconnect = null;
      if (document.hidden) return;
      disconnect = connectAppEvents({
        url: () => url,
        onChanged: (event) => invalidations.changed(event),
        onReady: (event) => {
          onStatus?.("live");
          invalidations.ready(event.revision);
        },
        onStatus,
      });
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      disconnect?.();
    };
  }, [onStatus, queryClient, readyKey, url]);
}

/**
 * Says the live updates stopped while the stream reconnects: until then views do not change by
 * themselves. Once it is back, its ready event refreshes what was missed. A required restart has
 * its own banner, which asks for a reload instead.
 */
function ReconnectingBanner() {
  const connection = useEventConnection();
  const restartRequired = useBackendRestartRequired();
  if (connection !== "reconnecting" || restartRequired) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-100 flex items-center justify-center gap-2 border-b border-warning/40 bg-background px-4 py-2 text-sm text-foreground shadow-sm"
      role="status"
    >
      <Spinner aria-hidden />
      <Trans>
        서버와 연결이 끊겨 다시 연결하는 중입니다. 그동안 화면이 최신 상태가 아닐 수 있습니다.
      </Trans>
    </div>
  );
}

/** One stream carries global, project, and session invalidations. */
export function AppEventsProvider({ children }: PropsWithChildren) {
  const [connection, setConnection] = useState<EventConnectionState>("connecting");
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
