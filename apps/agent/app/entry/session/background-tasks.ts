import { HashSet } from "effect";
import type { TraceTaskView } from "memory-agent";
import { t } from "@lingui/core/macro";

/** Task statuses in which a background job is still going. */
const runningStatuses = HashSet.fromIterable<TraceTaskView["status"]>([
  "queued",
  "running",
  "waiting",
  "resuming",
]);

/** Background shell commands and external-agent turns of a session that are still going. */
export const runningBackgroundTasks = (tasks: readonly TraceTaskView[]) =>
  tasks.filter(
    (task) =>
      task.agentName.startsWith("background_") &&
      HashSet.has(runningStatuses, task.status) &&
      task.archivedAt === null &&
      task.deleteRequestedAt === null,
  );

/** What kind of background job a task is, in the UI's words. */
export const backgroundKindLabel = (task: TraceTaskView) =>
  task.agentName === "background_external_agent"
    ? t({
        message: "외부 에이전트",
        comment: "Kind of background job: a turn of an external coding agent",
      })
    : t({ message: "셸 명령", comment: "Kind of background job: a shell command" });
