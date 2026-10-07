import { modelMessagesToUIMessages, type ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vite-plus/test";
import {
  groupHistoryMessages as computeHistoryGroups,
  historyProjectionMessages,
} from "./history-groups.ts";

function groupHistoryMessages(threadId: string, messages: readonly ModelMessage[]) {
  const result = computeHistoryGroups(threadId, messages);
  switch (result.type) {
    case "ready":
      return result.groups;
    case "id-collision":
      throw new Error(`Unexpected fixture ID collision: ${result.id}`);
  }
}

const linkedMessages: ModelMessage[] = [
  { id: "user", role: "user", content: "Question" },
  {
    id: "assistant",
    role: "assistant",
    content: "Checking",
    toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
  },
  { id: "orphan", role: "tool", content: "Standalone" },
  { id: "result", role: "tool", toolCallId: "call", content: '{"ok":true}' },
  {
    id: "assistant-segment-1",
    role: "assistant",
    content: "Done",
    thinking: [{ content: "Public summary" }],
  },
  { id: "next-user", role: "user", content: "Follow-up" },
  { id: "after-user", role: "tool", toolCallId: "call", content: "Standalone after user" },
];

describe("history storage UI groups", () => {
  it("allocates stable fallback IDs around explicit IDs and retains published cursors", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "Legacy" },
      { id: "user", role: "user", content: "Next" },
      { id: "stored:thread:0", role: "assistant", content: "Explicit" },
      { id: "stored:thread:0:fallback:0", role: "user", content: "Reserved" },
    ];
    const original = JSON.stringify(messages);
    const normalized = historyProjectionMessages("thread", messages, []);
    expect(normalized).toMatchObject({ type: "ready" });
    switch (normalized.type) {
      case "id-collision":
        throw new Error("Unexpected fallback collision");
      case "ready": {
        expect(normalized.messages[0]!.id).toBe("stored:thread:0:fallback:1");
        expect(normalized.messages.slice(1)).toEqual(messages.slice(1));
        expect(historyProjectionMessages("thread", messages, [])).toEqual(normalized);
        const retained = [normalized.messages[0]!.id!];
        const changed = historyProjectionMessages("thread", messages.slice(0, 2), retained);
        expect(changed).toMatchObject({
          type: "ready",
          messages: [expect.objectContaining({ id: retained[0] }), messages[1]],
        });
        expect(
          historyProjectionMessages(
            "thread",
            [...messages, { id: retained[0], role: "user", content: "Conflict" }],
            retained,
          ),
        ).toEqual({ type: "id-collision", id: retained[0] });
        expect(
          historyProjectionMessages(
            "thread",
            [
              { role: "assistant", content: "Legacy" },
              { id: "stored:thread:0", role: "user", content: "Conflict" },
            ],
            ["stored:thread:0"],
          ),
        ).toEqual({ type: "id-collision", id: "stored:thread:0" });
        break;
      }
    }
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("folds reused assistant IDs into stable SDK segments without changing the transcript", () => {
    const messages: ModelMessage[] = [
      { id: "user", role: "user", content: "Question" },
      {
        id: "answer",
        role: "assistant",
        content: "Checking",
        toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "call", content: "Result" },
      { id: "answer", role: "assistant", content: "Done", thinking: [{ content: "Summary" }] },
      { id: "next", role: "user", content: "Follow-up" },
    ];
    const original = JSON.stringify(messages);
    const groups = groupHistoryMessages("thread", messages);
    expect(groups.map((group) => group.id)).toEqual(["user", "answer", "next"]);
    const ui = modelMessagesToUIMessages(groups[1]!.messages);
    expect(ui).toHaveLength(1);
    expect(ui[0]!.id).toBe("answer");
    expect(ui[0]!.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", content: "Checking" }),
        expect.objectContaining({ type: "tool-result", toolCallId: "call", content: "Result" }),
        expect.objectContaining({ type: "text", content: "Done" }),
      ]),
    );
    expect(groups[1]!.messages[2]!.id).toBe("answer-segment-history-3");
    expect(
      groupHistoryMessages("thread", [
        ...messages,
        { id: "last", role: "assistant", content: "New" },
      ]).slice(0, 3),
    ).toEqual(groups);
    expect(JSON.stringify(messages)).toBe(original);
    expect(
      computeHistoryGroups("thread", [
        ...messages,
        { id: "answer-segment-history-3", role: "user", content: "Collision" },
      ]),
    ).toEqual({ type: "id-collision", id: "answer-segment-history-3" });
    expect(
      computeHistoryGroups("thread", [
        ...messages,
        { id: "answer", role: "assistant", content: "Unrelated answer" },
      ]),
    ).toEqual({ type: "id-collision", id: "answer" });
  });
  it("reports an appended ID collision instead of silently changing a legacy cursor", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Old" }];
    const previousId = groupHistoryMessages("thread", messages)[0]!.id;
    const before = JSON.stringify(messages);
    expect(
      computeHistoryGroups("thread", [
        ...messages,
        { id: previousId, role: "user", content: "New" },
      ]),
    ).toEqual({ type: "id-collision", id: previousId });
    expect(groupHistoryMessages("thread", messages)[0]!.id).toBe(previousId);
    expect(JSON.stringify(messages)).toBe(before);
    expect(
      computeHistoryGroups("thread", [
        { id: "duplicate", role: "user", content: "One" },
        { id: "duplicate", role: "user", content: "Two" },
      ]),
    ).toEqual({ type: "id-collision", id: "duplicate" });
  });
  it("matches the full SDK conversion including noncontiguous results and segments", () => {
    const groups = groupHistoryMessages("thread", linkedMessages);
    expect(groups.map((group) => group.id)).toEqual([
      "user",
      "assistant",
      "orphan",
      "next-user",
      "after-user",
    ]);
    expect(groups.flatMap((group) => modelMessagesToUIMessages(group.messages))).toEqual(
      modelMessagesToUIMessages(linkedMessages),
    );
    for (let boundary = 0; boundary <= groups.length; boundary++) {
      expect(
        modelMessagesToUIMessages(groups.slice(0, boundary).flatMap((group) => group.messages)),
      ).toEqual(modelMessagesToUIMessages(linkedMessages).slice(0, boundary));
      expect(
        modelMessagesToUIMessages(groups.slice(boundary).flatMap((group) => group.messages)),
      ).toEqual(modelMessagesToUIMessages(linkedMessages).slice(boundary));
    }
  });

  it("creates stable isolated legacy IDs without mutating the original transcript", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Legacy question" },
      { role: "assistant", content: "Legacy answer" },
      { role: "tool", toolCallId: "legacy-call", content: "Legacy detail" },
    ];
    const before = JSON.stringify(messages);
    const groups = groupHistoryMessages("thread-a", messages);
    expect(groupHistoryMessages("thread-a", messages)).toEqual(groups);
    expect(groupHistoryMessages("thread-b", messages)[0]?.id).not.toBe(groups[0]?.id);
    expect(JSON.stringify(messages)).toBe(before);
    const appended = groupHistoryMessages("thread-a", [
      ...messages,
      { role: "user", content: "New" },
    ]);
    expect(appended.slice(0, groups.length)).toEqual(groups);
    expect(
      modelMessagesToUIMessages(groups.flatMap((group) => group.messages)).map(
        (message) => message.id,
      ),
    ).toEqual(groups.map((group) => group.id));
  });

  it("does not merge unrelated assistants and preserves result errors and metadata", () => {
    const messages: ModelMessage[] = [
      { id: "first", role: "assistant", content: "First" },
      { id: "second", role: "assistant", content: "Second" },
      {
        id: "error",
        role: "tool",
        toolCallId: "missing-call",
        content: "failed",
        error: "read failed",
        metadata: { source: "fixture" },
      },
    ];
    const groups = groupHistoryMessages("thread", messages);
    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => modelMessagesToUIMessages(group.messages))).toEqual(
      modelMessagesToUIMessages(messages),
    );
  });
});
