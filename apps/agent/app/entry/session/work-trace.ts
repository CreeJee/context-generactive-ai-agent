import { uiPromise } from "../shared/ui-effect";
import { Effect, Fiber, Function as EffectFunction } from "effect";
import { useQueryClient } from "@tanstack/react-query";
import type { TraceTaskView } from "memory-agent";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useProjectScope } from "../events/context";
import { sessionQueries, useSessionTraceQuery } from "../queries/session";

export type TraceConnection = "connecting" | "live" | "reconnecting";

/** Statuses of a task that has not ended: it runs, waits to, or waits on someone. */
export const activeTaskStatuses: readonly TraceTaskView["status"][] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "resuming",
];

/** Tasks still going, that nobody asked to archive or delete. */
export const runningTasks = (tasks: readonly TraceTaskView[]) =>
  tasks.filter(
    (task) =>
      activeTaskStatuses.includes(task.status) &&
      task.archivedAt === null &&
      task.deleteRequestedAt === null,
  );

/** Match a call to its latest durable task, including after a resumed attempt. */
const taskForToolCallBody = (tasks: readonly TraceTaskView[], toolCallId: string) =>
  tasks.findLast((task) => task.parentToolCallId === toolCallId);
export const taskForToolCall: {
  (toolCallId: string): (tasks: readonly TraceTaskView[]) => ReturnType<typeof taskForToolCallBody>;
} & typeof taskForToolCallBody = EffectFunction.dual(2, taskForToolCallBody);

/** One session-level subscription shared by every in-conversation task card. */
export function useWorkTrace(sessionId: string) {
  const projectId = useProjectScope("work_trace");
  const queryClient = useQueryClient();
  const options = sessionQueries.trace(projectId, sessionId);
  const query = useSessionTraceQuery(projectId, sessionId);
  const [connection, setConnection] = useState<TraceConnection>("connecting");

  useEffect(() => {
    let active = true;
    let refreshing = false;
    let dirty = false;
    let source: EventSource | null = null;
    let refreshFiber: Fiber.Fiber<void> | null = null;
    const refresh = () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      refreshFiber = Effect.runFork(
        Effect.gen(function* () {
          while (active && dirty) {
            dirty = false;
            yield* uiPromise(() => queryClient.invalidateQueries({ queryKey: options.queryKey }));
          }
        }).pipe(
          Effect.catchTag("UnknownError", () =>
            Effect.sync(() => {
              if (active) setConnection("reconnecting");
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              refreshing = false;
            }),
          ),
        ),
      );
    };
    const connect = () => {
      if (!active || document.hidden || source !== null) return;
      const cursor = queryClient.getQueryData<typeof query.data>(options.queryKey)?.cursor ?? 0;
      source = new EventSource(api.workTraceStreamUrl(sessionId, cursor));
      source.addEventListener("open", () => setConnection("live"));
      source.addEventListener("snapshot", refresh);
      source.addEventListener("trace", refresh);
      source.addEventListener("progress", refresh);
      source.addEventListener("error", () => setConnection("reconnecting"));
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        source?.close();
        source = null;
        setConnection("connecting");
      } else {
        void queryClient.invalidateQueries({ queryKey: options.queryKey }).finally(connect);
      }
    };
    window.addEventListener("work-trace:changed", refresh);
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      active = false;
      if (refreshFiber !== null) Effect.runFork(Fiber.interrupt(refreshFiber));
      window.removeEventListener("work-trace:changed", refresh);
      document.removeEventListener("visibilitychange", visibilityChanged);
      source?.close();
    };
  }, [projectId, sessionId, queryClient]);

  const tasks = query.data?.tasks ?? [];
  return { tasks, connection, failed: query.isError };
}
