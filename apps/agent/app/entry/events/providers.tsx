import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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
    const disconnect = connectAppEvents({
      url: () => url,
      onChanged: (event) => invalidations.changed(event),
      onReady: () => {
        onStatus?.("live");
        invalidations.ready();
      },
      onStatus,
    });
    return () => {
      disconnect();
      invalidations.close();
    };
  }, [onStatus, queryClient, readyKey, url]);
}

/** One project-scoped invalidation stream while that project is selected. */
export function ProjectEventsProvider({
  projectId,
  children,
}: PropsWithChildren<{ readonly projectId: string | null }>) {
  const readyKey = useMemo(
    () => (projectId ? appQueryKeys.project.root(projectId) : appQueryKeys.global.root),
    [projectId],
  );
  useScopedEvents(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/events` : null,
    readyKey,
  );
  return children;
}

/** Global invalidations exist only while OAuth or settings background work needs them. */
export function GlobalEventsProvider({
  active,
  children,
}: PropsWithChildren<{ readonly active: boolean }>) {
  const readyKey = useMemo(() => appQueryKeys.global.root, []);
  useScopedEvents(active ? "/api/events" : null, readyKey);
  return children;
}

export function SessionEventsProvider({
  projectId,
  sessionId,
  children,
}: PropsWithChildren<{ readonly projectId: string | null; readonly sessionId: string | null }>) {
  const [connection, setConnection] = useState<EventConnectionState>("connecting");
  const readyKey = useMemo(
    () =>
      projectId && sessionId
        ? appQueryKeys.session.root(projectId, sessionId)
        : appQueryKeys.global.root,
    [projectId, sessionId],
  );
  useScopedEvents(
    projectId && sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/events` : null,
    readyKey,
    setConnection,
  );

  return (
    <SessionEventScopeContext value={{ projectId, sessionId }}>
      <EventConnectionContext value={connection}>{children}</EventConnectionContext>
    </SessionEventScopeContext>
  );
}
