import type { UIMessage } from "@tanstack/ai-react";
import type { QueuedMessage } from "memory-agent/definitions";
import { describe, expect, test } from "vite-plus/test";
import { missingDeliveredMessages } from "./delivered-messages";

// SAFETY: this unit only reads id, role and text parts; both synthetic fixtures provide them.
const user = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", content: text }] }) as UIMessage;
// SAFETY: the synthetic assistant has every field the reconciliation unit reads.
const assistant = (id: string): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", content: "answer" }] }) as UIMessage;
const delivered = (id: string, text: string): QueuedMessage => ({
  id,
  seq: 1,
  text,
  attachmentIds: [],
  state: { kind: "delivered", via: "tool_boundary", runId: "run" },
  createdAt: 1,
});

describe("delivered message reconciliation", () => {
  test("does not repeat a queued turn already in the transcript by id", () => {
    const item = delivered("queued", "follow-up");
    expect(missingDeliveredMessages([item], [user("queued", "follow-up")])).toEqual([]);
    expect(missingDeliveredMessages([item], [user("other", "original")])).toEqual([item]);
  });

  test("reconciles older transcripts that lacked the queue id", () => {
    const item = delivered("queued", "follow-up");
    expect(
      missingDeliveredMessages(
        [item],
        [user("original", "question"), assistant("answer"), user("stored", "follow-up")],
      ),
    ).toEqual([]);
    expect(missingDeliveredMessages([item], [user("original", "follow-up")])).toEqual([item]);
  });

  test("does not use an id-matched turn to hide another identical message", () => {
    const first = delivered("one", "same");
    const second = delivered("two", "same");
    expect(
      missingDeliveredMessages([first, second], [assistant("a"), user("one", "same")]),
    ).toEqual([second]);
  });

  test("only consumes one old transcript turn for each delivered message", () => {
    const first = delivered("one", "same");
    const second = delivered("two", "same");
    expect(
      missingDeliveredMessages([first, second], [assistant("a"), user("old", "same")]),
    ).toEqual([second]);
  });
});
