import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
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

const sdkCall = Effect.fn("BrowserTest.sdkCall")(<A,>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
