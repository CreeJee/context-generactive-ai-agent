import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import type { ChatMetadata } from "../chat-store/metadata.ts";
import type { StoredMessage } from "../chat-store/schema.ts";
import {
  budgetFor,
  clearedOutput,
  compactEffect,
  estimateTokens,
  lightweightToolResults,
  lookupSources,
  requestHistory,
  type Budget,
  type CompactionSources,
} from "./compaction.ts";

const noLimit = 1_000_000;
const unlimited: Budget = { compactAt: noLimit, leaveOutAt: noLimit, inputCeiling: noLimit };
const noSources = lookupSources({ toolResultId: () => null, nodeText: () => null });
const fresh = { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] };

/** A session with nothing stored about compacting it. */
const noMetadata: ChatMetadata = {
  get: () => Effect.undefined,
  set: () => Effect.void,
  summaries: () => Effect.succeed([]),
  replaceSummaries: () => Effect.void,
};

/** What the model is sent on a request over `messages` of a session with nothing stored. */
const firstSent = (
  messages: ReadonlyArray<StoredMessage>,
  sources: CompactionSources,
  budget: Budget,
) =>
  Effect.map(
    requestHistory({
      metadata: noMetadata,
      threadId: "thread",
      messages,
      restored: null,
      sources,
      budget,
    }),
    (sent) => sent.messages,
  );

/** A run_shell exchange whose answered output the model already read. */
const answeredShell: ReadonlyArray<StoredMessage> = [
  { role: "user", content: "earlier question" },
  {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "old-1", type: "function", function: { name: "run_shell", arguments: "{}" } },
    ],
  },
  { role: "tool", toolCallId: "old-1", content: "large earlier output" },
  { role: "assistant", content: "done" },
  // A later answered run: only then is old-1 cleared.
  { role: "user", content: "follow-up" },
  { role: "assistant", content: "answered" },
  { role: "user", content: "current question" },
];

describe("compact", () => {
  it.effect("a summarized image turn is not sent again", () =>
    Effect.gen(function* () {
      const messages: StoredMessage[] = [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", value: "/old-image" } }],
        },
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "current question" },
      ];
      const result = yield* compactEffect({
        messages,
        state: {
          manual: { clearedThrough: 0, summarizedTurns: 0 },
          blocks: [{ end: 1, nextTurnNodeId: "next", text: "Earlier image discussed." }],
        },
        sources: lookupSources({ toolResultId: () => null, nodeText: () => "current question" }),
        budget: budgetFor(noLimit),
      });
      expect(result.stage).toBe("summarize");
      expect(result.messages.some((message) => Array.isArray(message.content))).toBe(false);
    }),
  );

  it.effect("drops a tool result when compaction has removed its matching tool call", () =>
    Effect.gen(function* () {
      const result = yield* compactEffect({
        messages: [
          { role: "assistant", content: "earlier call was compacted" },
          { role: "tool", toolCallId: "orphaned", content: "result without a call" },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "paired",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          { role: "tool", toolCallId: "paired", content: "paired result" },
          { role: "user", content: "continue" },
        ],
        state: fresh,
        sources: noSources,
        budget: unlimited,
      });
      expect(result.messages).not.toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: "orphaned" }),
      );
      expect(result.messages).toContainEqual(
        expect.objectContaining({ role: "tool", toolCallId: "paired" }),
      );
      expect(result.stage).toBe("clear-answered");
    }),
  );

  it.effect("does not leave messages out for room taken only by unreplayable output", () =>
    Effect.gen(function* () {
      const messages: StoredMessage[] = [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "partial", type: "function", function: { name: "run_shell", arguments: "{" } },
          ],
        },
        { role: "tool", toolCallId: "partial", content: "output ".repeat(4_000) },
        { role: "user", content: "continue" },
      ];
      const result = yield* compactEffect({
        messages,
        state: fresh,
        sources: noSources,
        budget: { compactAt: 0, leaveOutAt: 1_000, inputCeiling: noLimit },
      });
      expect(result.stage).toBe("clear-answered");
      expect(result.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
    }),
  );

  it.effect.each([true, false])(
    "omits incomplete historical calls without rewriting the transcript (result: %s)",
    (hasResult) =>
      Effect.gen(function* () {
        const validCall = {
          id: "valid",
          type: "function" as const,
          function: { name: "read_file", arguments: '{"path":"README.md"}' },
        };
        const partialResult: StoredMessage[] = hasResult
          ? [{ role: "tool", toolCallId: "partial", content: "partial result" }]
          : [];
        const messages: StoredMessage[] = [
          {
            role: "assistant",
            content: "진행 상황을 기록합니다.",
            toolCalls: [
              {
                id: "partial",
                type: "function",
                function: { name: "update_workflow_progress", arguments: '{"detail":"진행 중' },
              },
              validCall,
            ],
          },
          ...partialResult,
          { role: "tool", toolCallId: "valid", content: "valid result" },
          { role: "user", content: "continue" },
        ];
        const original = structuredClone(messages);
        const result = yield* compactEffect({
          messages,
          state: fresh,
          sources: noSources,
          budget: unlimited,
        });
        expect(result.messages).toEqual([
          { role: "assistant", content: "진행 상황을 기록합니다.", toolCalls: [validCall] },
          { role: "tool", toolCallId: "valid", content: "valid result" },
          { role: "user", content: "continue" },
        ]);
        expect(result.stage).toBe("clear-answered");
        expect(messages).toEqual(original);
      }),
  );

  // Anthropic streams no arguments for a call without parameters; dropping it hid the result from
  // the model, which then called the tool again on every step.
  it.effect("keeps a call stored with empty arguments and its result", () =>
    Effect.gen(function* () {
      const messages: StoredMessage[] = [
        { role: "user", content: "board?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "board",
              type: "function",
              function: { name: "read_kanban_board", arguments: "" },
            },
          ],
        },
        { role: "tool", toolCallId: "board", content: "board result" },
      ];
      const result = yield* compactEffect({
        messages,
        state: fresh,
        sources: noSources,
        budget: unlimited,
      });
      expect(result.messages).toEqual(messages);
    }),
  );

  // Retrieval cannot fail: its type has no error, so the request always goes.
  it.effect("adds bounded retrieval only after compaction omitted content", () =>
    Effect.gen(function* () {
      const appendixCalls = yield* Ref.make(0);
      const sources: CompactionSources = {
        ...lookupSources({
          toolResultId: (toolCallId) => (toolCallId === "old-1" ? "omitted-node" : null),
          nodeText: () => null,
        }),
        retrievalAppendix: () =>
          Ref.update(appendixCalls, (calls) => calls + 1).pipe(
            Effect.as({
              role: "assistant" as const,
              content: "[Retrieval appendix]\n- node omitted-node",
            }),
          ),
      };
      const compacted = yield* compactEffect({
        messages: answeredShell,
        state: fresh,
        sources,
        budget: unlimited,
      });
      expect(yield* Ref.get(appendixCalls)).toBe(1);
      expect(compacted.messages.at(-2)).toEqual({
        role: "assistant",
        content: "[Retrieval appendix]\n- node omitted-node",
      });
      expect(compacted.messages.at(-1)).toEqual({ role: "user", content: "current question" });
      const intactCalls = yield* Ref.make(0);
      yield* compactEffect({
        messages: [{ role: "user", content: "uncompacted" }],
        state: fresh,
        sources: {
          ...sources,
          retrievalAppendix: () =>
            Ref.update(intactCalls, (calls) => calls + 1).pipe(Effect.as(null)),
        },
        budget: unlimited,
      });
      expect(yield* Ref.get(intactCalls)).toBe(0);
    }),
  );
});

describe("request history", () => {
  it.effect(
    "omits empty stored user text from provider input without erasing tool-only answers",
    () =>
      Effect.gen(function* () {
        const messages: StoredMessage[] = [
          { role: "user", content: "" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          },
          { role: "tool", toolCallId: "call", content: "result" },
          { role: "user", content: "continue" },
        ];
        expect(yield* firstSent(messages, noSources, budgetFor(noLimit))).toEqual(
          messages.slice(1),
        );
        expect(messages[0]?.content).toBe("");
      }),
  );

  it.effect("leaves out the oldest messages, pointing to memory, when nothing else is enough", () =>
    Effect.gen(function* () {
      const long = "배포 절차를 설명해요. ".repeat(100);
      const messages: StoredMessage[] = Array.from({ length: 10 }, (_, index) => [
        { role: "user" as const, content: `질문 ${index}: ${long}` },
        { role: "assistant" as const, content: `답 ${index}: ${long}` },
      ]).flat();
      messages.push({ role: "user", content: "마지막 질문" });
      const sent = yield* firstSent(messages, noSources, {
        compactAt: 3_000,
        leaveOutAt: 3_000,
        inputCeiling: noLimit,
      });
      expect(sent.length).toBeLessThan(messages.length);
      expect(sent[0]?.content).toContain("find_memory");
      expect(sent.at(-1)).toEqual({ role: "user", content: "마지막 질문" });
    }),
  );

  // A 100k-window model lost its instruction and what it had just read inside one run, read them
  // again, and went on for an hour without writing anything.
  it.effect("never leaves out the run in progress; its oldest outputs give way to pointers", () =>
    Effect.gen(function* () {
      const long = "배포 절차를 설명해요. ".repeat(100);
      const earlier: StoredMessage[] = Array.from({ length: 4 }, (_, index) => [
        { role: "user" as const, content: `질문 ${index}: ${long}` },
        { role: "assistant" as const, content: `답 ${index}: ${long}` },
      ]).flat();
      const steps: StoredMessage[] = Array.from({ length: 6 }, (_, index) => [
        {
          role: "assistant" as const,
          content: null,
          toolCalls: [
            {
              id: `read-${index}`,
              type: "function" as const,
              function: { name: "read_file", arguments: `{"path":"page-${index}.ts"}` },
            },
          ],
        },
        { role: "tool" as const, toolCallId: `read-${index}`, content: "스키마 줄 ".repeat(400) },
      ]).flat();
      const instruction: StoredMessage = { role: "user", content: "S8 작업 이어서 진행해줘" };
      const sent = yield* firstSent(
        [...earlier, instruction, ...steps],
        lookupSources({ toolResultId: (id) => `node-${id}`, nodeText: () => null }),
        { compactAt: 0, leaveOutAt: 6_000, inputCeiling: noLimit },
      );
      expect(sent[0]?.content).toContain("left out to save context");
      expect(sent[1]).toEqual(instruction);
      // Every call of the run is still sent, so the model knows what it already did.
      expect(sent.filter((message) => message.role === "assistant")).toHaveLength(6);
      const results = sent.filter((message) => message.role === "tool");
      expect(results[0]?.content).toBe(clearedOutput("node-read-0"));
      expect(results.at(-1)).toEqual(steps.at(-1));
    }),
  );

  it.effect("clears outputs before the run before it leaves out older messages", () =>
    Effect.gen(function* () {
      const messages: StoredMessage[] = [
        { role: "user", content: "스키마 읽어줘" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "schema", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", toolCallId: "schema", content: "스키마 줄 ".repeat(400) },
        { role: "assistant", content: "읽었어요" },
        { role: "user", content: "이어서 해줘" },
      ];
      const sent = yield* firstSent(
        messages,
        lookupSources({ toolResultId: (id) => `node-${id}`, nodeText: () => null }),
        { compactAt: 0, leaveOutAt: 1_000, inputCeiling: noLimit },
      );
      expect(sent).toEqual([
        ...messages.slice(0, 2),
        { role: "tool", toolCallId: "schema", content: clearedOutput("node-schema") },
        ...messages.slice(3),
      ]);
    }),
  );
});

describe("lightweight tool results", () => {
  const exchange = (name: string, args: string, content: string): StoredMessage[] => [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", type: "function", function: { name, arguments: args } }],
    },
    { role: "tool", toolCallId: "call-1", content },
  ];
  const recorded = (id: string) => (id === "call-1" ? "node-1" : null);

  it("shortens recorded tool outputs in provider copy while preserving status and evidence ID", () => {
    const output = JSON.stringify({
      status: "failed",
      exitCode: 2,
      signal: null,
      durationMs: 9,
      stdout: "log".repeat(3_000),
      stderr: `${"error".repeat(1_000)}FINAL DIAGNOSTIC`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const messages = exchange("run_shell", "{}", output);
    const provider = lightweightToolResults(messages, recorded);
    expect(provider[1]?.content).toContain("status");
    expect(provider[1]?.content).toContain("failed");
    expect(provider[1]?.content).toContain("exitCode");
    expect(provider[1]?.content).toContain("FINAL DIAGNOSTIC");
    expect(provider[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(provider).length).toBeLessThan(output.length / 2);
    expect(messages[1]?.content).toBe(output);
    expect(lightweightToolResults(messages, () => null)[1]?.content).toBe(output);
    const malformed = exchange(
      "run_shell",
      "{}",
      JSON.stringify({ error: "denied".repeat(1_000) }),
    );
    expect(lightweightToolResults(malformed, recorded)[1]?.content).toBe(malformed[1]?.content);
  });

  it("shell preview avoids echoing the command while preserving original and diagnostics", () => {
    const command = "unique-command-".repeat(80);
    const original = JSON.stringify({
      command,
      shell: "/bin/zsh",
      status: "succeeded",
      exitCode: 0,
      signal: null,
      durationMs: 12,
      stdout: "result".repeat(200),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const messages = exchange("run_shell", JSON.stringify({ command }), original);
    const sent = lightweightToolResults(messages, recorded);
    expect(sent[1]?.content).toContain('"status":"succeeded"');
    expect(sent[1]?.content).toContain('"exitCode":0');
    expect(sent[1]?.content).toContain("read_tool_result ID node-1");
    expect(sent[1]?.content).not.toContain(command);
    expect(sent[1]?.content).not.toContain('"shell":');
    expect(messages[1]?.content).toBe(original);
  });

  it.each([
    {
      name: "list_files",
      result: {
        total: 500,
        paths: Array.from({ length: 500 }, (_, index) => `folder/really-long-file-${index}.ts`),
        nextOffset: 500,
        snapshot: "snap",
        truncated: false,
        excludedCredentialFiles: 0,
      },
      essential: '"nextOffset":500',
    },
    {
      name: "search_files",
      result: {
        matches: Array.from({ length: 100 }, (_, index) => ({
          path: `very-long-folder/name-${index}.ts`,
          line: index + 1,
          text: "snippet".repeat(20),
        })),
        skipped: [],
        filesInView: 100,
        nextCursor: "cursor",
        complete: false,
      },
      essential: '"nextCursor":"cursor"',
    },
    {
      name: "get_subagent_report",
      result: {
        status: "completed",
        subagentId: "child",
        taskId: "task",
        attemptId: "attempt",
        agent: null,
        answer: "final".repeat(4_000),
        error: null,
      },
      essential: '"attemptId":"attempt"',
    },
  ])("$name keeps navigation and outcome while omitting bulk", ({ name, result, essential }) => {
    const original = JSON.stringify(result);
    const messages = exchange(name, "{}", original);
    const sent = lightweightToolResults(messages, recorded);
    expect(sent[1]?.content).toContain(essential);
    expect(sent[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(sent).length).toBeLessThan(original.length / 2);
    expect(messages[1]?.content).toBe(original);
  });

  it("shortens a sub-4000-character directory listing by default, without losing navigation", () => {
    const original = JSON.stringify({
      total: 80,
      paths: Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`),
      snapshot: "fixed-snapshot",
      nextOffset: 40,
      truncated: false,
      excludedCredentialFiles: 0,
    });
    expect(original.length).toBeLessThan(4_000);
    const messages = exchange("list_files", "{}", original);
    const result = lightweightToolResults(messages, recorded);
    expect(result[1]?.content).toContain('"snapshot":"fixed-snapshot"');
    expect(result[1]?.content).toContain('"nextOffset":40');
    expect(result[1]?.content).toContain("src/module-0.ts");
    expect(result[1]?.content).not.toContain("src/module-39.ts");
    expect(result[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(result[1]?.content).length).toBeLessThan(original.length);
    expect(messages[1]?.content).toBe(original);
  });
});

it("counts Korean closer to how models do than characters / 4", () => {
  expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
  expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
});
