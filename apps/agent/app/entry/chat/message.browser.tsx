import { render } from "vitest-browser-react";
import { expect, test } from "vite-plus/test";
import "../../app.css";
import { MessageView } from "./message";

const inactive = async () => {
  throw new Error("No task action expected");
};
const props = {
  awaitingApproval: [],
  tasks: [],
  traceConnection: "live" as const,
  readOnly: false,
  onResumeTask: inactive,
  onArchiveTask: inactive,
  onDeleteTask: inactive,
};

test("reasoning can be expanded while streaming and stays separate from the answer", async () => {
  const thinking = { type: "thinking" as const, content: "Compare the values." };
  const screen = await render(
    <MessageView
      {...props}
      streaming
      message={{ id: "reasoning", role: "assistant", parts: [thinking] }}
    />,
  );
  const trigger = screen.getByRole("button", { name: "추론 중" });
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect.element(screen.getByText("Compare the values.")).toBeVisible();
  await screen.rerender(
    <MessageView
      {...props}
      streaming={false}
      message={{
        id: "reasoning",
        role: "assistant",
        parts: [thinking, { type: "text", content: "The answer is 42." }],
      }}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "추론 내용" })).toBeVisible();
  await expect.element(screen.getByText("The answer is 42.")).toBeVisible();
  await screen.getByRole("button", { name: "추론 내용" }).click();
  await expect
    .element(screen.getByRole("button", { name: "추론 내용" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("The answer is 42.")).toBeVisible();
});
