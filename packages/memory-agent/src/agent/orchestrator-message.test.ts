import { describe, expect, it } from "vite-plus/test";
import { boardRunId } from "../kanban/board-run.ts";
import type { ParentNotificationView } from "../work-trace/store.ts";
import { endedTasks } from "./orchestrator-message.ts";

const notification = (
  taskId: string,
  parentRunId: string,
  agentName: string,
  kind = "completed",
): ParentNotificationView => ({
  id: `n-${taskId}`,
  taskId,
  parentRunId,
  agentName,
  kind,
  summary: "Subagent completed",
  payload: {},
  createdAt: 0,
});

describe("endedTasks", () => {
  it("counts the tasks the chat started, not the board's card attempts and checks", () => {
    expect(
      endedTasks([
        notification("t1", "chat-run", "explorer"),
        notification("t2", "chat-run", "background_shell"),
        notification("t3", "chat-run", "explorer", "resumed"),
        notification("c1", boardRunId("goal-1", "p1", 1), "card-p1-g1"),
        notification("c2", boardRunId("goal-1", "p1", "verify", "x"), "card-p1-verify"),
        notification("c3", boardRunId("goal-1", "p1", 2), "card-p1-g1", "failed"),
      ]),
    ).toEqual({ background: 1, subagent: 1 });
  });
});
