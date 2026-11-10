import type { TraceTaskView } from "memory-agent";
import { describe, expect, test } from "vite-plus/test";
import { backgroundKindLabel, runningBackgroundTasks } from "./background-tasks";

const task = (id: string, parentToolCallId: string): TraceTaskView => ({
  id,
  projectId: "project-1",
  originSessionId: "session-1",
  parentTaskId: null,
  parentRunId: "parent-run",
  parentToolCallId,
  agentId: `agent-${id}`,
  agentName: id,
  status: "running",
  title: `Task ${id}`,
  request: `Run ${id}`,
  activeAttemptId: `attempt-${id}`,
  latestAttemptId: `attempt-${id}`,
  latestAttemptStatus: "running",
  latestAttemptNumber: 1,
  latestResumedFromAttemptId: null,
  heartbeat: { state: "working", step: "working", at: 2 },
  latestFailure: null,
  archivedAt: null,
  deleteRequestedAt: null,
  deletedAt: null,
  purgeReceiptId: null,
  createdAt: 1,
  updatedAt: 2,
});

describe("running background tasks", () => {
  test("keeps only unfinished background_* tasks and labels their kind", () => {
    const background = (
      id: string,
      agentName: string,
      status: TraceTaskView["status"],
      extra: Partial<TraceTaskView> = {},
    ): TraceTaskView => ({ ...task(id, `call-${id}`), agentId: null, agentName, status, ...extra });
    const tasks = [
      background("shell", "background_shell", "running"),
      background("agent", "background_external_agent", "queued"),
      background("done", "background_shell", "completed"),
      background("failed", "background_shell", "failed"),
      background("cancelled", "background_shell", "cancelled"),
      background("interrupted", "background_shell", "interrupted"),
      background("archived", "background_shell", "running", { archivedAt: 3 }),
      background("deleting", "background_shell", "running", { deleteRequestedAt: 3 }),
      task("subagent", "call-subagent"),
    ];

    const running = runningBackgroundTasks(tasks);

    expect(running.map(({ id }) => id)).toEqual(["shell", "agent"]);
    expect(running.map(backgroundKindLabel)).toEqual(["스킬", "외부 에이전트"]);
  });
});
