import { describe, expect, it } from "vite-plus/test";
import type { StoredMessage } from "../chat-store/schema.ts";
import {
  groupHistoryMessages as computeHistoryGroups,
  type HistoryGroup,
  HistoryGroupingResult,
  HistoryMessagesResult,
  historyProjectionMessages,
} from "./history-groups.ts";

function groupHistoryMessages(threadId: string, messages: readonly StoredMessage[]) {
  return HistoryGroupingResult.$match(computeHistoryGroups(threadId, messages), {
    ready: ({ groups }) => groups,
    "id-collision": ({ id }) => {
      throw new Error(`Unexpected fixture ID collision: ${id}`);
    },
  });
}

/** Each group's id with the ids of its messages. */
const membership = (groups: readonly HistoryGroup[]) =>
  groups.map((group) => [group.id, group.messages.map((message) => message.id)]);

const linkedMessages: StoredMessage[] = [
  { id: "user", role: "user", content: "Question" },
  {
    id: "assistant",
    role: "assistant",
    content: "Checking",
    toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
  },
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
    const messages: StoredMessage[] = [
      { role: "assistant", content: "Legacy" },
      { id: "user", role: "user", content: "Next" },
      { id: "stored:thread:0", role: "assistant", content: "Explicit" },
      { id: "stored:thread:0:fallback:0", role: "user", content: "Reserved" },
    ];
    const original = JSON.stringify(messages);
    const normalized = historyProjectionMessages("thread", messages, []);
    expect(HistoryMessagesResult.$is("ready")(normalized)).toBe(true);
    HistoryMessagesResult.$match(normalized, {
      "id-collision": () => {
        throw new Error("Unexpected fallback collision");
      },
      ready: (ready) => {
        expect(ready.messages[0]!.id).toBe("stored:thread:0:fallback:1");
        expect(ready.messages.slice(1)).toEqual(messages.slice(1));
        expect(historyProjectionMessages("thread", messages, [])).toEqual(normalized);
        const retained = [ready.messages[0]!.id!];
        const changed = historyProjectionMessages("thread", messages.slice(0, 2), retained);
        expect(changed).toMatchObject(
          HistoryMessagesResult.ready({
            messages: [expect.objectContaining({ id: retained[0] }), messages[1]!],
          }),
        );
        expect(
          historyProjectionMessages(
            "thread",
            [...messages, { id: retained[0], role: "user", content: "Conflict" }],
            retained,
          ),
        ).toEqual(HistoryMessagesResult["id-collision"]({ id: retained[0]! }));
        expect(
          historyProjectionMessages(
            "thread",
            [
              { role: "assistant", content: "Legacy" },
              { id: "stored:thread:0", role: "user", content: "Conflict" },
            ],
            ["stored:thread:0"],
          ),
        ).toEqual(HistoryMessagesResult["id-collision"]({ id: "stored:thread:0" }));
      },
    });
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("folds reused assistant IDs into stable segments without changing the transcript", () => {
    const messages: StoredMessage[] = [
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
    expect(groups[1]!.messages).toEqual([
      messages[1],
      { ...messages[2], id: expect.stringMatching(/^history-legacy-/) },
      { ...messages[3], id: "answer-segment-history-3" },
    ]);
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
    ).toEqual(HistoryGroupingResult["id-collision"]({ id: "answer-segment-history-3" }));
    expect(
      computeHistoryGroups("thread", [
        ...messages,
        { id: "answer", role: "assistant", content: "Unrelated answer" },
      ]),
    ).toEqual(HistoryGroupingResult["id-collision"]({ id: "answer" }));
  });
  it("reports an appended ID collision instead of silently changing a legacy cursor", () => {
    const messages: StoredMessage[] = [{ role: "user", content: "Old" }];
    const previousId = groupHistoryMessages("thread", messages)[0]!.id;
    const before = JSON.stringify(messages);
    expect(
      computeHistoryGroups("thread", [
        ...messages,
        { id: previousId, role: "user", content: "New" },
      ]),
    ).toEqual(HistoryGroupingResult["id-collision"]({ id: previousId }));
    expect(groupHistoryMessages("thread", messages)[0]!.id).toBe(previousId);
    expect(JSON.stringify(messages)).toBe(before);
    expect(
      computeHistoryGroups("thread", [
        { id: "duplicate", role: "user", content: "One" },
        { id: "duplicate", role: "user", content: "Two" },
      ]),
    ).toEqual(HistoryGroupingResult["id-collision"]({ id: "duplicate" }));
  });
  it("keeps results and segments with their assistant, and a result after a user alone", () => {
    const groups = groupHistoryMessages("thread", linkedMessages);
    expect(membership(groups)).toEqual([
      ["user", ["user"]],
      ["assistant", ["assistant", "result", "assistant-segment-1"]],
      ["next-user", ["next-user"]],
      ["after-user", ["after-user"]],
    ]);
    expect(groups.flatMap((group) => group.messages)).toEqual(linkedMessages);
  });

  it("creates stable isolated legacy IDs without mutating the original transcript", () => {
    const messages: StoredMessage[] = [
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
    // Each group shows as its first message, whose id is the group's.
    expect(groups.map((group) => group.messages[0]?.id)).toEqual(groups.map((group) => group.id));
  });

  it("does not merge unrelated assistants and preserves result errors", () => {
    const messages: StoredMessage[] = [
      { id: "first", role: "assistant", content: "First" },
      { id: "second", role: "assistant", content: "Second" },
      {
        id: "error",
        role: "tool",
        toolCallId: "missing-call",
        content: "failed",
        error: "read failed",
      },
    ];
    const groups = groupHistoryMessages("thread", messages);
    expect(membership(groups)).toEqual([
      ["first", ["first"]],
      ["second", ["second", "error"]],
    ]);
    expect(groups[1]?.messages[1]).toEqual(messages[2]);
  });
});
