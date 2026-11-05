import { HashSet } from "effect";
import { expect, test } from "vite-plus/test";
import { budgetFor, estimateConversation } from "../agent/compaction.ts";
import { childRequestHistory, compactChildToolResults } from "./subagents.ts";

test("a child's run past the window's budget leaves its oldest results out, as a conversation's", () => {
  // One run: the task, then twelve steps that each read 3,000 characters (750 tokens).
  const steps = Array.from({ length: 12 }, (_, step) => [
    {
      role: "assistant" as const,
      content: null,
      toolCalls: [
        {
          id: `call-${step}`,
          type: "function" as const,
          function: { name: "read_file", arguments: `{"path":"f${step}"}` },
        },
      ],
    },
    { role: "tool" as const, toolCallId: `call-${step}`, content: "x".repeat(3_000) },
  ]);
  const messages = [{ role: "user" as const, content: "find the bug" }, ...steps.flat()];
  const budget = budgetFor(10_000);
  expect(estimateConversation(messages)).toBeGreaterThan(budget.leaveOutAt);
  const saved = HashSet.fromIterable(steps.map((_, step) => `call-${step}`));

  const sent = childRequestHistory({ messages, savedCallIds: saved, budget });
  expect(estimateConversation(sent)).toBeLessThanOrEqual(budget.leaveOutAt / 2);
  // The task and every call stay; the oldest results are pointers to the saved transcript.
  expect(sent).toHaveLength(messages.length);
  expect(sent[0]).toEqual(messages[0]);
  expect(sent[2]?.content).toContain("read_subagent_tool_result with this toolCallId");
  expect(sent[2]?.content).toContain("call-0");
  // The latest step's result is what the child asked for to go on: it stays whole.
  expect(sent.at(-1)).toEqual(messages.at(-1));

  // A result not saved yet cannot be read again, so it is not left out.
  const unsaved = childRequestHistory({
    messages,
    savedCallIds: HashSet.empty<string>(),
    budget,
  });
  expect(unsaved).toEqual(messages);
  // Within the budget nothing changes.
  expect(
    childRequestHistory({ messages, savedCallIds: saved, budget: budgetFor(100_000) }),
  ).toEqual(messages);
});

test("older saved child results are references only in the provider copy", () => {
  const content = "output".repeat(1_000);
  const messages = [
    { role: "tool" as const, toolCallId: "old", content },
    { role: "assistant" as const, content: "finished" },
    { role: "tool" as const, toolCallId: "current", content },
  ];
  const sent = compactChildToolResults(messages, HashSet.fromIterable(["old", "current"]));
  expect(sent[0]?.content).toContain("read_subagent_tool_result");
  expect(JSON.stringify(sent[0]?.content).length).toBeLessThan(content.length / 10);
  expect(sent[2]?.content).toContain("Child tool result preview");
  expect(sent[2]?.content).toContain("read_subagent_tool_result");
  expect(JSON.stringify(sent[2]?.content).length).toBeLessThan(content.length);
  // The caller's messages stay whole, and results that were never saved pass through.
  expect(messages[2]?.content).toBe(content);
  expect(messages[0]?.content).toBe(content);
  expect(compactChildToolResults(messages, HashSet.empty<string>())[0]?.content).toBe(content);
});
