import { it } from "@effect/vitest";
import { Effect, HashMap, Iterable } from "effect";
import { expect } from "vite-plus/test";
import {
  budgetFor,
  type CompactionSources,
  type CompactionState,
  type ConversationMessage,
  compactEffect,
  estimateConversation,
} from "../agent/compaction.ts";
import { childFailureOf } from "./subagents.ts";

const noCompaction: CompactionState = {
  manual: { clearedThrough: 0, summarizedTurns: 0 },
  blocks: [],
};

/** A step that reads one file, and what it read. */
const read = (id: string, characters: number): ConversationMessage[] => [
  {
    role: "assistant",
    content: null,
    toolCalls: [
      { id, type: "function", function: { name: "read_file", arguments: `{"path":"${id}"}` } },
    ],
  },
  { role: "tool", toolCallId: id, content: "x".repeat(characters) },
];

/**
 * What the child's session recorded of `saved`: each tool result is a memory node, named here
 * `node-<call id>`.
 */
const recordedIn = (saved: ReadonlyArray<ConversationMessage>): CompactionSources => ({
  toolResultIds: (toolCallIds) =>
    Effect.succeed(
      HashMap.fromIterable(
        Iterable.map(
          Iterable.filter(toolCallIds, (id) =>
            saved.some((message) => message.role === "tool" && message.toolCallId === id),
          ),
          (id) => [id, `node-${id}`] as const,
        ),
      ),
    ),
  nodeTexts: () => Effect.succeed(HashMap.empty()),
});

/** A child's request as the conversation's compaction makes it, from the child's own session. */
const compacted = (
  messages: ReadonlyArray<ConversationMessage>,
  saved: ReadonlyArray<ConversationMessage>,
  window: number,
) =>
  Effect.map(
    compactEffect({
      messages,
      state: noCompaction,
      sources: recordedIn(saved),
      budget: budgetFor(window),
    }),
    ({ messages: sent }) => sent,
  );

it.effect("a child's run past the window's budget leaves its oldest results out", () =>
  Effect.gen(function* () {
    // One run: the task, then twelve steps that each read 3,000 characters (750 tokens).
    const steps = Array.from({ length: 12 }, (_, step) => read(`call-${step}`, 3_000));
    const messages = [{ role: "user" as const, content: "find the bug" }, ...steps.flat()];
    expect(estimateConversation(messages)).toBeGreaterThan(budgetFor(10_000).leaveOutAt);

    const sent = yield* compacted(messages, messages, 10_000);
    expect(estimateConversation(sent)).toBeLessThanOrEqual(budgetFor(10_000).leaveOutAt / 2);
    // The task and every call stay; the oldest results point at their nodes in the child's session.
    expect(sent).toHaveLength(messages.length);
    expect(sent[0]).toEqual(messages[0]);
    expect(sent[2]?.content).toBe("[Tool output cleared. Reread: read_evidence node-call-0]");
    // The latest step's result is what the child asked for to go on: it stays whole.
    expect(sent.at(-1)).toEqual(messages.at(-1));

    // A result not recorded yet cannot be read again, so it is not left out.
    expect(yield* compacted(messages, [], 10_000)).toEqual(messages);
    // Within the budget nothing changes.
    expect(yield* compacted(messages, messages, 100_000)).toEqual(messages);
  }),
);

it.effect(
  "a child's answered task has its tool output cleared once the next task is answered",
  () =>
    Effect.gen(function* () {
      const messages: ConversationMessage[] = [
        { role: "user", content: "first task" },
        ...read("first", 40),
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second task" },
        ...read("second", 40),
        { role: "assistant", content: "second answer" },
        { role: "user", content: "third task" },
      ];
      const sent = yield* compacted(messages, messages, 100_000);
      expect(sent[2]?.content).toContain("read_evidence node-first");
      // The latest answered task stays whole: the next request is usually about what it read.
      expect(sent[6]).toEqual(messages[6]);
    }),
);

it("a child's report names why its run stopped when the run's code says", () => {
  expect(childFailureOf("context_limit_exceeded")._tag).toBe("ContextLimitExceeded");
  expect(childFailureOf("repeated_tool_call")._tag).toBe("RepeatedToolCall");
  // Any other code, or none, is the model's error: the run's text is never read.
  expect(childFailureOf("run_failed")._tag).toBe("ModelRunError");
  expect(childFailureOf(undefined)._tag).toBe("ModelRunError");
});
