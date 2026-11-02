import type { ChatMessage } from "memory-agent/chat-api";
import { type QueuedMessage, QueueItemState } from "memory-agent/definitions";
import { describe, expect, test } from "vite-plus/test";
import { missingDeliveredMessages } from "./delivered-messages";

const user = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});
const delivered = (id: string, text: string): QueuedMessage => ({
  id,
  seq: 1,
  text,
  attachmentIds: [],
  state: QueueItemState.delivered({ via: "tool_boundary", runId: "run" }),
  createdAt: 1,
});

describe("delivered message reconciliation", () => {
  test("does not repeat a queued turn already in the transcript by id", () => {
    const item = delivered("queued", "follow-up");
    expect(missingDeliveredMessages([item], [user("queued", "follow-up")])).toEqual([]);
    expect(missingDeliveredMessages([item], [user("other", "original")])).toEqual([item]);
  });
});
