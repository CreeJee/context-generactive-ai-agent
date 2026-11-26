import { describe, expect, it } from "vite-plus/test";
import type { StoredMessage } from "../chat-store/schema.ts";
import { boardRunId } from "../kanban/board-run.ts";
import { RunEnd } from "../loop/store.ts";
import type { TaskStatusNotification } from "../work-trace/task-status.ts";
import { endedTasks, heardBy, telling, toldIds, toldIn } from "./orchestrator-message.ts";

const notification = (
  taskId: string,
  parentRunId: string,
  kind: TaskStatusNotification["kind"] = "completed",
): TaskStatusNotification => ({
  _tag: "TaskStatus",
  id: `n-${taskId}`,
  taskId,
  parentRunId,
  kind,
  summary: "Subagent completed",
  detail: {},
});

describe("endedTasks", () => {
  it("counts the tasks the chat started, not the board's card attempts and checks", () => {
    expect(
      endedTasks({
        tasks: [
          notification("t1", "chat-run"),
          notification("t2", "chat-run", "failed"),
          notification("t3", "chat-run", "resumed"),
          notification("c1", boardRunId("goal-1", "p1", 1)),
          notification("c2", boardRunId("goal-1", "p1", "verify", "x")),
          notification("c3", boardRunId("goal-1", "p1", 2), "failed"),
        ],
        background: [
          {
            taskId: "b1",
            parentRunId: "chat-run",
            kind: "shell",
            title: "ls",
            status: "completed",
          },
          {
            taskId: "b2",
            parentRunId: boardRunId("goal-1", "p1", 1),
            kind: "shell",
            title: "ls",
            status: "failed",
          },
        ],
      }),
    ).toEqual({ background: 1, subagent: 2 });
  });
});

describe("toldIds", () => {
  it("lists the status changes and the background ends", () => {
    expect(
      toldIds({
        tasks: [notification("t-1", "run-1")],
        background: [
          {
            taskId: "b-1",
            parentRunId: "run-1",
            kind: "shell",
            title: "ls",
            status: "completed",
          },
        ],
      }),
    ).toEqual(["n-t-1", "b-1"]);
  });
});

/** The ids of a set, in order. */
const sorted = (ids: Iterable<string>) => Array.from(ids).sort();

/** A conversation whose last message tells two notifications, with no answer after it. */
const told: ReadonlyArray<StoredMessage> = [
  { role: "user", content: "a" },
  telling(["n-1", "n-2"])({ role: "user", content: "<orchestrator>…" }),
];

describe("toldIn", () => {
  it("reads the ids the conversation's messages tell", () => {
    const said = toldIn(told);
    expect(sorted(said.told)).toEqual(["n-1", "n-2"]);
    expect(sorted(said.answered)).toEqual([]);
  });

  it("counts a notification answered once an answer comes after its message", () => {
    const said = toldIn([...told, { role: "assistant", content: "ok" }]);
    expect(sorted(said.answered)).toEqual(["n-1", "n-2"]);
  });

  it("does not count a failed answer", () => {
    const said = toldIn([...told, { role: "assistant", content: "half", stopReason: "error" }]);
    expect(sorted(said.answered)).toEqual([]);
    expect(sorted(said.told)).toEqual(["n-1", "n-2"]);
  });

  it("a message that tells none carries no list", () => {
    expect(telling([])({ role: "user", content: "x" })).toEqual({ role: "user", content: "x" });
  });
});

describe("heardBy", () => {
  it("a run that finished delivered everything its conversation tells", () => {
    expect(sorted(heardBy(RunEnd.Completed(), told))).toEqual(["n-1", "n-2"]);
    expect(sorted(heardBy(RunEnd.Interrupted(), told))).toEqual(["n-1", "n-2"]);
  });

  it("a run that did not finish delivered only what the model answered", () => {
    expect(sorted(heardBy(RunEnd.Aborted(), told))).toEqual([]);
    expect(
      sorted(heardBy(RunEnd.Aborted(), [...told, { role: "assistant", content: "ok" }])),
    ).toEqual(["n-1", "n-2"]);
  });
});
