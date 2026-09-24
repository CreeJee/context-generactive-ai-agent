import type { TraceTaskView } from "memory-agent";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

export type TraceConnection = "connecting" | "live" | "reconnecting";

/** Stable placement: parallel child calls keep their own parent tool-call card. */
export const indexTasksByToolCall = (tasks: readonly TraceTaskView[]) =>
  new Map(tasks.map((task) => [task.parentToolCallId, task] as const));

/** One session-level subscription shared by every in-conversation task card. */
export function useWorkTrace(sessionId: string) {
  const [tasks, setTasks] = useState<readonly TraceTaskView[]>([]);
  const [connection, setConnection] = useState<TraceConnection>("connecting");

  useEffect(() => {
    let active = true;
    let cursor = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSource | null = null;
    const refresh = async () => {
      try {
        const snapshot = await api.workTrace(sessionId);
        if (!active) return;
        cursor = Math.max(cursor, snapshot.cursor);
        setTasks(snapshot.tasks);
      } catch {
        if (active) setConnection("reconnecting");
      }
    };
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, 50);
    };

    const connect = () => {
      if (!active || document.hidden || source) return;
      source = new EventSource(api.workTraceStreamUrl(sessionId, cursor));
      source.addEventListener("open", () => setConnection("live"));
      source.addEventListener("snapshot", scheduleRefresh);
      source.addEventListener("trace", scheduleRefresh);
      source.addEventListener("error", () => setConnection("reconnecting"));
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        source?.close();
        source = null;
        setConnection("connecting");
      } else {
        void refresh().finally(connect);
      }
    };
    window.addEventListener("work-trace:changed", scheduleRefresh);
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      active = false;
      window.removeEventListener("work-trace:changed", scheduleRefresh);
      document.removeEventListener("visibilitychange", visibilityChanged);
      source?.close();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [sessionId]);

  const tasksByToolCall = useMemo(() => indexTasksByToolCall(tasks), [tasks]);
  return { tasks, tasksByToolCall, connection };
}
