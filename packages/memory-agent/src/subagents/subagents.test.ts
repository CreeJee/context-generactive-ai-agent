import { HashSet } from "effect";
import { expect, test } from "vite-plus/test";
import { compactChildToolResults } from "./subagents.ts";

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
