import { describe, expect, it } from "vite-plus/test";
import type { StoredMessage } from "../chat-store/schema.ts";
import { type MessageIdentity, displayIds, displayStarts } from "./display-messages.ts";

/** The shown messages of a whole transcript, as the ids of the messages each one holds. */
const shown = (messages: ReadonlyArray<StoredMessage>) => {
  const starts = displayStarts(messages, 0);
  return starts.map((start, index) =>
    messages.slice(start, starts[index + 1] ?? messages.length).map((message) => message.id),
  );
};

/** The ids of a whole transcript's shown messages, built with nothing kept. */
const idsOf = (threadId: string, messages: ReadonlyArray<MessageIdentity>) =>
  displayIds({ threadId, messages, starts: displayStarts(messages, 0), taken: [] });

const call = { id: "call", type: "function", function: { name: "read", arguments: "{}" } } as const;

describe("shown messages", () => {
  it("keeps results and segments with their assistant, and a result after a user alone", () => {
    expect(
      shown([
        { id: "user", role: "user", content: "Question" },
        { id: "assistant", role: "assistant", content: "Checking", toolCalls: [call] },
        { id: "result", role: "tool", toolCallId: "call", content: '{"ok":true}' },
        { id: "assistant-segment-1", role: "assistant", content: "Done" },
        { id: "next-user", role: "user", content: "Follow-up" },
        { id: "after-user", role: "tool", toolCallId: "call", content: "Standalone after user" },
      ]),
    ).toEqual([
      ["user"],
      ["assistant", "result", "assistant-segment-1"],
      ["next-user"],
      ["after-user"],
    ]);
  });

  it("folds an assistant message that repeats the answer's id into the answer", () => {
    expect(
      shown([
        { id: "user", role: "user", content: "Question" },
        { id: "answer", role: "assistant", content: "Checking", toolCalls: [call] },
        { role: "tool", toolCallId: "call", content: "Result" },
        { id: "answer", role: "assistant", content: "Done" },
        { id: "next", role: "user", content: "Follow-up" },
      ]),
    ).toEqual([["user"], ["answer", undefined, "answer"], ["next"]]);
  });

  it("does not merge unrelated assistants, nor ones without an id", () => {
    expect(
      shown([
        { id: "first", role: "assistant", content: "First" },
        { id: "second", role: "assistant", content: "Second" },
        {
          id: "error",
          role: "tool",
          toolCallId: "missing",
          content: "failed",
          error: "read failed",
        },
        { role: "assistant", content: "Legacy" },
        { role: "assistant", content: "Legacy again" },
      ]),
    ).toEqual([["first"], ["second", "error"], [undefined], [undefined]]);
  });

  it("finds the same shown messages from any message that begins one", () => {
    const messages: ReadonlyArray<StoredMessage> = [
      { id: "u", role: "user", content: "Question" },
      { id: "a", role: "assistant", content: "Checking", toolCalls: [call] },
      { role: "tool", toolCallId: "call", content: "Result" },
      { id: "a-segment-1", role: "assistant", content: "Done" },
      { role: "tool", toolCallId: "orphan", content: "Orphan" },
      { id: "v", role: "user", content: "Next" },
    ];
    const starts = displayStarts(messages, 0);
    expect(starts).toEqual([0, 1, 5]);
    expect(starts.map((start) => displayStarts(messages, start))).toEqual([[0, 1, 5], [1, 5], [5]]);
  });
});

describe("shown message ids", () => {
  it("are the first message's id, or one made from the thread and position", () => {
    expect(
      idsOf("thread", [
        { role: "user" },
        { role: "assistant" },
        { id: "", role: "user" },
        { id: "own", role: "user" },
      ]),
    ).toEqual(["stored:thread:0", "stored:thread:1", "stored:thread:2", "own"]);
  });

  it("leave the ids messages carry to them and step a made one past them", () => {
    expect(
      idsOf("thread", [
        { role: "assistant" },
        { id: "user", role: "user" },
        { id: "stored:thread:0", role: "assistant" },
        { id: "stored:thread:0:fallback:0", role: "user" },
      ]),
    ).toEqual([
      "stored:thread:0:fallback:1",
      "user",
      "stored:thread:0",
      "stored:thread:0:fallback:0",
    ]);
  });

  it("give a message that repeats an id the first free fallback of it", () => {
    expect(
      idsOf("thread", [
        { id: "same", role: "user" },
        { id: "same", role: "user" },
        { id: "same:fallback:0", role: "user" },
      ]),
    ).toEqual(["same", "same:fallback:1", "same:fallback:0"]);
  });

  it("step a made id past the ids of messages inside a shown message", () => {
    expect(
      idsOf("thread", [
        { id: "a", role: "assistant" },
        { id: "stored:thread:2", role: "tool" },
        { id: "u", role: "user" },
        { role: "tool" },
      ]),
    ).toEqual(["a", "u", "stored:thread:3"]);
    expect(
      idsOf("thread", [
        { id: "a", role: "assistant" },
        { id: "stored:thread:3", role: "tool" },
        { id: "u", role: "user" },
        { role: "tool" },
      ]),
    ).toEqual(["a", "u", "stored:thread:3:fallback:0"]);
  });

  it("never take an id a kept shown message holds", () => {
    expect(
      displayIds({
        threadId: "thread",
        messages: [
          { id: "k", role: "user" },
          { id: "l", role: "user" },
          { id: "m", role: "user" },
          { id: "kept", role: "user" },
          { role: "user" },
        ],
        starts: [3, 4],
        taken: ["kept", "stored:thread:4"],
      }),
    ).toEqual(["kept:fallback:0", "stored:thread:4:fallback:0"]);
  });
});
