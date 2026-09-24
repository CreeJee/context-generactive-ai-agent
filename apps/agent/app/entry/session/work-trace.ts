import { useQueryClient } from "@tanstack/react-query";
import type { TraceTaskView } from "memory-agent";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useSessionEventScope } from "../events/context";
import { sessionQueries, useSessionTraceQuery } from "../queries/session";

export type TraceConnection = "connecting" | "live" | "reconnecting";

/** Match a call to its latest durable task, including after a resumed attempt. */
export const taskForToolCall = (tasks: readonly TraceTaskView[], toolCallId: string) =>
  tasks.findLast((task) => task.parentToolCallId === toolCallId);

/** One session-level subscription shared by every in-conversation task card. */
export function useWorkTrace(sessionId: string) {
  const { projectId } = useSessionEventScope();
  if (!projectId) throw new Error("Work trace requires an active project");
  const queryClient = useQueryClient();
  const options = sessionQueries.trace(projectId, sessionId);
  const query = useSessionTraceQuery(projectId, sessionId);
  const [connection, setConnection] = useState<TraceConnection>("connecting");

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let dirty = false;
    let source: EventSource | null = null;
    const refresh = () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      void (async () => {
        try {
          while (active && dirty) {
            dirty = false;
            await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
          }
        } finally {
          refreshing = false;
        }
      })();
    };
    const connect = () => {
      if (!active || document.hidden || source) return;
      const cursor = queryClient.getQueryData<typeof query.data>(options.queryKey)?.cursor ?? 0;
      source = new EventSource(api.workTraceStreamUrl(sessionId, cursor));
      source.addEventListener("open", () => setConnection("live"));
      source.addEventListener("snapshot", refresh);
      source.addEventListener("trace", refresh);
      source.addEventListener("error", () => setConnection("reconnecting"));
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        source?.close();
        source = null;
        setConnection("connecting");
      } else {
        void queryClient
          .invalidateQueries({ queryKey: options.queryKey, exact: true })
          .finally(connect);
      }
    };
    window.addEventListener("work-trace:changed", refresh);
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      active = false;
      window.removeEventListener("work-trace:changed", refresh);
      document.removeEventListener("visibilitychange", visibilityChanged);
      source?.close();
    };
  }, [projectId, sessionId, queryClient]);

  const tasks = query.data?.tasks ?? [];
  return { tasks, connection };
}
