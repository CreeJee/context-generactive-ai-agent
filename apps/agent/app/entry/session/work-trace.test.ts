import type { TraceTaskView } from "memory-agent";
import { describe, expect, test } from "vite-plus/test";
import { taskForToolCall } from "./work-trace";

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
  latestActivity: "working",
  latestActivityAt: 2,
  archivedAt: null,
  deleteRequestedAt: null,
  deletedAt: null,
  purgeReceiptId: null,
  createdAt: 1,
  updatedAt: 2,
});

describe("Work Trace task-card placement", () => {
  test("parallel child calls resolve to distinct durable tasks and attempts", () => {
    const first = task("first", "tool-call-a");
    const second = task("second", "tool-call-b");
    const tasks = [first, second];

    expect(taskForToolCall(tasks, "tool-call-a")).toMatchObject({
      id: "first",
      latestAttemptId: "attempt-first",
    });
    expect(taskForToolCall(tasks, "tool-call-b")).toMatchObject({
      id: "second",
      latestAttemptId: "attempt-second",
    });
    expect(taskForToolCall(tasks, "tool-call-a")).not.toBe(taskForToolCall(tasks, "tool-call-b"));
  });
});
