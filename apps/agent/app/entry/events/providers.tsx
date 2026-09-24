import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { EventConnectionContext, SessionEventScopeContext } from "./context";
import { connectAppEvents, type EventConnectionState } from "./event-source";
import { createInvalidationBatch } from "./invalidation";
import { appQueryKeys } from "./query-keys";

function useScopedEvents(
  url: string | null,
  readyKey: readonly unknown[],
  onStatus?: (state: EventConnectionState) => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!url) return;
    const invalidations = createInvalidationBatch(
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
        onReady: () => {
          onStatus?.("live");
          invalidations.ready();
        },
        onStatus,
      });
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      disconnect?.();
      invalidations.close();
    };
  }, [onStatus, queryClient, readyKey, url]);
}

/** One stream carries global, project, and session invalidations. */
export function AppEventsProvider({ children }: PropsWithChildren) {
  const [connection, setConnection] = useState<EventConnectionState>("connecting");
  useScopedEvents("/api/events", appQueryKeys.root, setConnection);
  return <EventConnectionContext value={connection}>{children}</EventConnectionContext>;
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
