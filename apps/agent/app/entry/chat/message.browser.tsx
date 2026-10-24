import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import type { TraceTaskView } from "memory-agent";
import { render } from "vitest-browser-react";
import { expect } from "vite-plus/test";
import "../../app.css";
import { MessageView } from "./message";

const inactive = () => Promise.reject(new Error("No task action expected"));
const props = {
  awaitingApproval: [],
  tasks: [],
  traceConnection: "live" as const,
  readOnly: false,
  onResumeTask: inactive,
  onArchiveTask: inactive,
  onDeleteTask: inactive,
};

it.live("reasoning can be expanded while streaming and stays separate from the answer", () =>
  Effect.gen(function* () {
    const thinking = { type: "thinking" as const, content: "Compare the values." };
    const screen = yield* sdkCall(() =>
      render(
        <MessageView
          {...props}
          streaming
          message={{ id: "reasoning", role: "assistant", parts: [thinking] }}
        />,
      ),
    );
    const trigger = screen.getByRole("button", { name: "추론 중" });
    yield* sdkCall(() => expect.element(trigger).toHaveAttribute("aria-expanded", "false"));
    yield* sdkCall(() => trigger.click());
    yield* sdkCall(() => expect.element(screen.getByText("Compare the values.")).toBeVisible());
    yield* sdkCall(() =>
      screen.rerender(
        <MessageView
          {...props}
          streaming={false}
          message={{
            id: "reasoning",
            role: "assistant",
            parts: [thinking, { type: "text", content: "The answer is 42." }],
          }}
        />,
      ),
    );
    yield* sdkCall(() =>
      expect.element(screen.getByRole("button", { name: "추론 내용" })).toBeVisible(),
    );
    yield* sdkCall(() => expect.element(screen.getByText("The answer is 42.")).toBeVisible());
    yield* sdkCall(() => screen.getByRole("button", { name: "추론 내용" }).click());
    yield* sdkCall(() =>
      expect
        .element(screen.getByRole("button", { name: "추론 내용" }))
        .toHaveAttribute("aria-expanded", "false"),
    );
    yield* sdkCall(() => expect.element(screen.getByText("The answer is 42.")).toBeVisible());
  }),
);

it.live("an unchanged message still follows its own call's approval and task", () =>
  Effect.gen(function* () {
    // The same message object each time: only the session-wide lists change around it.
    const message = {
      id: "delegating",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call" as const,
          id: "call-1",
          name: "run_subagent",
          arguments: "{}",
          state: "input-complete" as const,
        },
      ],
    };
    const task: TraceTaskView = {
      id: "task-1",
      projectId: "project-1",
      originSessionId: "session-1",
      parentTaskId: null,
      parentRunId: "run-1",
      parentToolCallId: "call-1",
      agentId: "agent-1",
      agentName: "reviewer",
      status: "running",
      title: "Review",
      request: "Review the change",
      activeAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      latestAttemptStatus: "running",
      latestAttemptNumber: 1,
      latestResumedFromAttemptId: null,
      heartbeat: { state: "working", step: "reading files", at: 2 },
      latestFailure: null,
      archivedAt: null,
      deleteRequestedAt: null,
      deletedAt: null,
      purgeReceiptId: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const screen = yield* sdkCall(() =>
      render(<MessageView {...props} streaming={false} message={message} />),
    );
    yield* sdkCall(() => expect.element(screen.getByText("실행 중")).toBeVisible());
    yield* sdkCall(() =>
      screen.rerender(
        <MessageView
          {...props}
          streaming={false}
          message={message}
          awaitingApproval={["other-call", "call-1"]}
        />,
      ),
    );
    yield* sdkCall(() => expect.element(screen.getByText("승인 대기")).toBeVisible());
    yield* sdkCall(() =>
      screen.rerender(
        <MessageView {...props} streaming={false} message={message} tasks={[task]} />,
      ),
    );
    yield* sdkCall(() =>
      expect
        .element(screen.getByRole("region", { name: "서브에이전트 작업: Review" }))
        .toBeVisible(),
    );
    yield* sdkCall(() => expect.element(screen.getByText("reading files")).toBeVisible());
  }),
);

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
