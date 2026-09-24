import { randomUUID } from "node:crypto";
import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ApiUsage } from "../src/agent/api-usage.ts";
import {
  coldObservationId,
  consumeColdObservation,
  contextUsageNamespace,
  pendingColdObservation,
  type StoredContextUsage,
} from "../src/agent/context-usage.ts";
import {
  clearedOutput,
  compact,
  compaction,
  estimateTokens,
  lightweightToolResults,
  turnSummariesNamespace,
  type Budget,
  type CompactionSources,
} from "../src/agent/compaction.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { testRuntime } from "./support/runtime.ts";

/** Records the conversation as the engine keeps it, whatever the model was sent. */
function canonical() {
  let latest: readonly ModelMessage[] = [];
  const middleware: ChatMiddleware = {
    name: "test/canonical",
    onFinish: (ctx) => {
      latest = [...ctx.messages];
    },
  };
  return { saved: () => latest, middleware };
}

const decodeCompact = Schema.decodeUnknownSync(
  Schema.Struct({
    cleared: Schema.Number,
    summarizedTurns: Schema.Number,
    summaryFailed: Schema.Boolean,
    tokensBefore: Schema.Number,
    tokensAfter: Schema.Number,
  }),
);
const decodeStatus = Schema.decodeUnknownSync(
  Schema.Struct({
    context: Schema.Struct({
      usedTokens: Schema.NullOr(Schema.Number),
      cachedTokens: Schema.NullOr(Schema.Number),
      cacheRatio: Schema.NullOr(Schema.Number),
      compactionStage: Schema.NullOr(
        Schema.Literal("none", "clear-answered", "summarize", "leave-out"),
      ),
      windowTokens: Schema.Number,
      compactAtTokens: Schema.Number,
    }),
  }),
);
const StreamEvent = Schema.parseJson(
  Schema.Struct({
    type: Schema.String,
    name: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
);

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // drain
  }
}

const noLimit = 1_000_000;

const sourcesOf = (nodes: Effect.Effect.Success<typeof Nodes>, sessionId: string) =>
  ({
    toolResultIds: () => nodes.toolResultIds(sessionId),
    nodeText: (id) => nodes.get(id)?.text ?? null,
  }) satisfies CompactionSources;

/** What the model is sent on the first call of a run over `messages`. */
async function firstSent(
  messages: readonly ModelMessage[],
  middleware: ChatMiddleware,
  threadId: string = randomUUID(),
) {
  const adapter = new ScriptedTextAdapter([{ text: "네" }]);
  await drain(chat({ adapter, threadId, messages: [...messages], middleware: [middleware] }));
  return adapter.invocations[0]?.messages ?? [];
}

/**
 * A conversation of `answers.length + 1` user turns, recorded in memory the way runs record it.
 * The first answer used a tool.
 */
function conversation(
  nodes: Effect.Effect.Success<typeof Nodes>,
  at: { readonly projectId: string; readonly sessionId: string },
  answers: readonly string[],
) {
  const userNodes: Node[] = [];
  const messages: ModelMessage[] = [];
  const toolOutput = "테스트 결과 ".repeat(200);
  let toolResult: Node | null = null;
  answers.forEach((answer, index) => {
    const question = `질문 ${index + 1}`;
    userNodes.push(nodes.append({ ...at, kind: "user", text: question }));
    messages.push({ role: "user", content: question });
    if (index === 0) {
      nodes.append({
        ...at,
        kind: "tool_call",
        text: 'run_shell {"command":"pnpm test"}',
        detail: { toolName: "run_shell", toolCallId: "old-1" },
      });
      toolResult = nodes.append({
        ...at,
        kind: "tool_result",
        text: toolOutput,
        detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
      });
      messages.push(
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "old-1",
              type: "function",
              function: { name: "run_shell", arguments: '{"command":"pnpm test"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "old-1", content: toolOutput },
      );
    }
    nodes.append({ ...at, kind: "assistant", text: answer });
    messages.push({ role: "assistant", content: answer });
  });
  const last = `질문 ${answers.length + 1}`;
  userNodes.push(nodes.append({ ...at, kind: "user", text: last }));
  messages.push({ role: "user", content: last });
  return { userNodes, messages, toolOutput, toolResult: toolResult! };
}

describe("cache-cold observation", () => {
  const usage = (
    cachedTokens: number | null,
    observationId: string | null,
  ): StoredContextUsage => ({
    inputTokens: 100,
    cachedTokens,
    observationId,
    compactionStage: "none",
  });

  test("only explicit identifiable zero triggers, once per provider observation", () => {
    expect(coldObservationId(null, null)).toBeNull();
    expect(coldObservationId(usage(null, "first"), null)).toBeNull();
    expect(coldObservationId(usage(12, "first"), null)).toBeNull();
    expect(coldObservationId(usage(0, null), null)).toBeNull();
    expect(coldObservationId(usage(0, "first"), null)).toBe("first");
    expect(coldObservationId(usage(0, "first"), "first")).toBeNull();
    expect(coldObservationId(usage(0, "second"), "first")).toBe("second");
  });

  test("persists consumption while legacy/missing usage keeps its existing behavior", async () => {
    const { runtime, session } = await testRuntime();
    const metadata = await runtime.runPromise(
      Effect.map(ChatState, (state) => state.persistence.stores.metadata),
    );
    expect(await pendingColdObservation(metadata, session.id)).toBeNull();
    await metadata.set(contextUsageNamespace, session.id, { inputTokens: 100, cachedTokens: 0 });
    expect(await pendingColdObservation(metadata, session.id)).toBeNull();
    await metadata.set(contextUsageNamespace, session.id, usage(0, "first"));
    expect(await pendingColdObservation(metadata, session.id)).toBe("first");
    await consumeColdObservation(metadata, session.id, "first");
    expect(await pendingColdObservation(metadata, session.id)).toBeNull();
    await metadata.set(contextUsageNamespace, session.id, usage(0, "second"));
    expect(await pendingColdObservation(metadata, session.id)).toBe("second");
    await metadata.set(contextUsageNamespace, session.id, { inputTokens: 100 });
    expect(await pendingColdObservation(metadata, session.id)).toBeNull();
  });
});

describe("compaction", () => {
  test("shortens recorded tool outputs in provider copy while preserving status and evidence ID", () => {
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
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "run_shell", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: output },
    ];
    const provider = lightweightToolResults(messages, () => new Map([["call-1", "node-1"]]));
    expect(provider[1]?.content).toContain("status");
    expect(provider[1]?.content).toContain("failed");
    expect(provider[1]?.content).toContain("exitCode");
    expect(provider[1]?.content).toContain("FINAL DIAGNOSTIC");
    expect(provider[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(provider).length).toBeLessThan(output.length / 2);
    expect(messages[1]?.content).toBe(output);
    expect(lightweightToolResults(messages, () => new Map())[1]?.content).toBe(output);
    const malformed: ModelMessage[] = [
      messages[0]!,
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ error: "denied".repeat(1_000) }),
      },
    ];
    expect(
      lightweightToolResults(malformed, () => new Map([["call-1", "node-1"]]))[1]?.content,
    ).toBe(malformed[1]?.content);
  });

  test("list/search and reviewed child reports keep navigation and outcome while omitting bulk", () => {
    const cases = [
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
          evidenceRefIds: ["evidence-1"],
        },
        essential: '"evidenceRefIds":["evidence-1"]',
      },
    ];
    for (const { name, result, essential } of cases) {
      const original = JSON.stringify(result);
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-1", type: "function", function: { name, arguments: "{}" } }],
        },
        { role: "tool", toolCallId: "call-1", content: original },
      ];
      const sent = lightweightToolResults(messages, () => new Map([["call-1", "node-1"]]));
      expect(sent[1]?.content).toContain(essential);
      expect(sent[1]?.content).toContain("read_tool_result ID node-1");
      expect(JSON.stringify(sent).length).toBeLessThan(original.length / 2);
      expect(messages[1]?.content).toBe(original);
    }
  });

  test("shortens a sub-4000-character directory listing by default, without losing navigation", () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`);
    const original = JSON.stringify({
      total: 80,
      paths,
      snapshot: "fixed-snapshot",
      nextOffset: 40,
      truncated: false,
      excludedCredentialFiles: 0,
    });
    expect(original.length).toBeLessThan(4_000);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "list_files", arguments: "{}" } },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: original },
    ];
    const result = lightweightToolResults(messages, () => new Map([["call-1", "node-1"]]));
    expect(result[1]?.content).toContain('"snapshot":"fixed-snapshot"');
    expect(result[1]?.content).toContain('"nextOffset":40');
    expect(result[1]?.content).toContain("src/module-0.ts");
    expect(result[1]?.content).not.toContain("src/module-39.ts");
    expect(result[1]?.content).toContain("read_tool_result ID node-1");
    expect(JSON.stringify(result[1]?.content).length).toBeLessThan(original.length);
    expect(messages[1]?.content).toBe(original);
  });

  test("read_tool_result pages the saved original but refuses another conversation and other kinds", async () => {
    const { runtime, project, session } = await testRuntime();
    const nodes = await runtime.runPromise(Nodes);
    const other = await runtime.runPromise(
      Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
    );
    const text = "saved original".repeat(500);
    const own = nodes.append({
      projectId: project.id,
      sessionId: session.id,
      kind: "tool_result",
      text,
    });
    const foreign = nodes.append({
      projectId: project.id,
      sessionId: other.id,
      kind: "tool_result",
      text,
    });
    const wrongKind = nodes.append({
      projectId: project.id,
      sessionId: session.id,
      kind: "assistant",
      text,
    });
    const memory = await runtime.runPromise(MemoryTools);
    const tools = memory.forRun({
      projectId: project.id,
      sessionId: session.id,
      runId: "r1",
      userNodeId: wrongKind.id,
    }).tools;
    const execute = tools[3]?.execute;
    if (!execute) throw new Error("read_tool_result unavailable");
    const first = await execute({ id: own.id, offset: 0 });
    expect(first).toMatchObject({ id: own.id, text: text.slice(0, 4_000), nextOffset: 4_000 });
    expect(await execute({ id: own.id, offset: 4_000 })).toMatchObject({
      text: text.slice(4_000),
      nextOffset: null,
    });
    expect(await execute({ id: foreign.id })).toEqual({ error: "not_found", id: foreign.id });
    expect(await execute({ id: wrongKind.id })).toEqual({ error: "not_found", id: wrongKind.id });
  });

  test("cold usage compacts below the normal threshold on the next request only", async () => {
    const { runtime, project, session } = await testRuntime();
    const { nodes, metadata } = await runtime.runPromise(
      Effect.all({
        nodes: Nodes,
        metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
      }),
    );
    const { messages } = conversation(nodes, { projectId: project.id, sessionId: session.id }, [
      "one",
      "two",
      "three",
      "four",
    ]);
    const middleware = compaction(metadata, sourcesOf(nodes, session.id), {
      compactAt: noLimit,
      leaveOutAt: noLimit,
    });
    const sent = () => firstSent(messages, middleware, session.id);
    expect((await sent())[0]).toEqual({ role: "user", content: "질문 1" });
    await metadata.set(contextUsageNamespace, session.id, { inputTokens: 100, cachedTokens: null });
    expect((await sent())[0]).toEqual({ role: "user", content: "질문 1" });
    await metadata.set(contextUsageNamespace, session.id, {
      inputTokens: 100,
      cachedTokens: 0,
      observationId: "cold-1",
    });
    const early = await sent();
    expect(early[0]?.content).toContain("earlier messages of this conversation were left out");
    expect(early).toContainEqual({ role: "user", content: "질문 4" });
    expect(early.at(-1)).toEqual({ role: "user", content: "질문 5" });
    expect(await pendingColdObservation(metadata, session.id)).toBeNull();
    // Consumption is durable: the same observation does not trigger again after the first attempt.
    expect((await sent())[0]).toEqual({ role: "user", content: "질문 1" });
    await metadata.set(contextUsageNamespace, session.id, {
      inputTokens: 100,
      cachedTokens: 0,
      observationId: "cold-2",
    });
    expect((await sent())[0]?.content).toContain(
      "earlier messages of this conversation were left out",
    );
  });

  test("drops a tool result when compaction has removed its matching tool call", async () => {
    const messages: ModelMessage[] = [
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
    ];
    const result = await compact(
      messages,
      { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
      { toolResultIds: () => new Map(), nodeText: () => null },
      { compactAt: noLimit, leaveOutAt: noLimit },
    );

    expect(result.messages).not.toContainEqual(
      expect.objectContaining({ role: "tool", toolCallId: "orphaned" }),
    );
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "tool", toolCallId: "paired" }),
    );
    expect(result.stage).toBe("clear-answered");
  });

  test("clears tool output the model already answered from, and keeps the run's own whole", async () => {
    const { runtime, project, session } = await testRuntime();
    const { nodes, tools, metadata } = await runtime.runPromise(
      Effect.all({
        nodes: Nodes,
        tools: Effect.map(MemoryTools, (memory) => memory.forProject(project.id)),
        metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
      }),
    );
    const at = { projectId: project.id, sessionId: session.id };
    const output = "빌드 로그 ".repeat(1_000);
    nodes.append({ ...at, kind: "user", text: "빌드 로그 봐 줘" });
    nodes.append({
      ...at,
      kind: "tool_call",
      text: 'run_shell {"command":"pnpm build"}',
      detail: { toolName: "run_shell", toolCallId: "old-1" },
    });
    const result = nodes.append({
      ...at,
      kind: "tool_result",
      text: output,
      detail: { toolName: "run_shell", toolCallId: "old-1", ok: true },
    });

    const messages: ModelMessage[] = [
      { role: "user", content: "빌드 로그 봐 줘" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "old-1",
            type: "function",
            function: { name: "run_shell", arguments: '{"command":"pnpm build"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "old-1", content: output },
      { role: "assistant", content: "빌드는 성공했어요." },
      { role: "user", content: "그 로그 다시 읽어 줘" },
    ];
    const adapter = new ScriptedTextAdapter([
      {
        toolCalls: [
          { id: "new-1", name: "read_evidence", arguments: JSON.stringify({ id: result.id }) },
        ],
      },
      { text: "다시 읽었어요." },
    ]);
    const { saved, middleware } = canonical();
    // The log (about 4,500 tokens) is over budget; the page read_evidence returns in this run
    // (about 3,000) is not.
    const budget: Budget = { compactAt: 4_000, leaveOutAt: noLimit };
    await drain(
      chat({
        adapter,
        messages,
        tools,
        threadId: session.id,
        middleware: [middleware, compaction(metadata, sourcesOf(nodes, session.id), budget)],
      }),
    );

    const [first, second] = adapter.invocations;
    const toolContent = (sent: readonly ModelMessage[] | undefined, id: string) =>
      sent?.find((message) => message.role === "tool" && message.toolCallId === id)?.content;
    // The answered output is replaced by a pointer to its memory node.
    expect(toolContent(first?.messages, "old-1")).toBe(clearedOutput(result.id));
    expect(first?.messages.at(-1)).toEqual({ role: "user", content: "그 로그 다시 읽어 줘" });
    // The output of the call in progress reaches the model whole.
    expect(toolContent(second?.messages, "old-1")).toBe(clearedOutput(result.id));
    expect(toolContent(second?.messages, "new-1")).toEqual(
      expect.stringContaining("빌드 로그 빌드 로그"),
    );
    // The conversation that is saved keeps every output.
    expect(toolContent(saved(), "old-1")).toBe(output);
  });

  test("sends earlier turns as their summaries once clearing is not enough, if they still fit", async () => {
    const { runtime, project, session } = await testRuntime();
    const { nodes, metadata } = await runtime.runPromise(
      Effect.all({
        nodes: Nodes,
        metadata: Effect.map(ChatState, (state) => state.persistence.stores.metadata),
      }),
    );
    const long = "배포 절차를 설명해요. ".repeat(50);
    const { userNodes, messages } = conversation(
      nodes,
      { projectId: project.id, sessionId: session.id },
      [long, long, long, long, long],
    );
    await metadata.set(turnSummariesNamespace, session.id, {
      blocks: [{ end: 2, nextTurnNodeId: userNodes[2]!.id, text: "- 배포 절차를 정했다" }],
    });
    const sources = sourcesOf(nodes, session.id);
    const sent = (budget: Budget, conversation: readonly ModelMessage[]) =>
      firstSent(conversation, compaction(metadata, sources, budget), session.id);

    const firstBlock = await sent({ compactAt: 1_000, leaveOutAt: noLimit }, messages);
    expect(firstBlock[0]).toEqual({
      role: "assistant",
      content: expect.stringContaining("user turns 1-2"),
    });
    expect(firstBlock[0]?.content).toContain("- 배포 절차를 정했다");
    expect(firstBlock[1]).toEqual({ role: "user", content: "질문 3" });
    expect(firstBlock.at(-1)).toEqual({ role: "user", content: "질문 6" });

    await metadata.set(turnSummariesNamespace, session.id, {
      blocks: [
        { end: 2, nextTurnNodeId: userNodes[2]!.id, text: "- 배포 절차를 정했다" },
        { end: 4, nextTurnNodeId: userNodes[4]!.id, text: "- 배포 검증을 마쳤다" },
      ],
    });
    const twoBlocks = await sent({ compactAt: 1_000, leaveOutAt: noLimit }, messages);
    expect(twoBlocks[0]).toEqual(firstBlock[0]);
    expect(twoBlocks[1]?.content).toContain("user turns 3-4");
    expect(twoBlocks[2]).toEqual({ role: "user", content: "질문 5" });

    // Stored blocks are the monotonic watermark: falling under budget never restores raw turns.
    expect(await sent({ compactAt: noLimit, leaveOutAt: noLimit }, messages)).toEqual(twoBlocks);

    // A conversation whose turn 3 is not the one summarized gets no summary.
    const other = messages.map((message) =>
      message.role === "user" && message.content === "질문 3"
        ? { ...message, content: "다른 질문" }
        : message,
    );
    expect((await sent({ compactAt: 1_000, leaveOutAt: noLimit }, other))[0]).toEqual({
      role: "user",
      content: "질문 1",
    });
  });

  test("leaves out the oldest messages, pointing to memory, when nothing else is enough", async () => {
    const { runtime } = await testRuntime();
    const metadata = await runtime.runPromise(
      Effect.map(ChatState, (state) => state.persistence.stores.metadata),
    );
    const long = "배포 절차를 설명해요. ".repeat(100);
    const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `질문 ${index}: ${long}` },
      { role: "assistant" as const, content: `답 ${index}: ${long}` },
    ]).flat();
    messages.push({ role: "user", content: "마지막 질문" });
    const sources: CompactionSources = { toolResultIds: () => new Map(), nodeText: () => null };

    const sent = await firstSent(
      messages,
      compaction(metadata, sources, { compactAt: 3_000, leaveOutAt: 3_000 }),
    );
    expect(sent.length).toBeLessThan(messages.length);
    expect(sent[0]?.content).toContain("find_memory");
    expect(sent.at(-1)).toEqual({ role: "user", content: "마지막 질문" });
  });

  test("adds bounded retrieval only after compaction omitted content, and continues on failure", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "old-1",
            type: "function",
            function: { name: "run_shell", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "old-1", content: "large earlier output" },
      { role: "assistant", content: "done" },
      { role: "user", content: "current question" },
    ];
    let appendixCalls = 0;
    const sources: CompactionSources = {
      toolResultIds: () => new Map([["old-1", "omitted-node"]]),
      nodeText: () => null,
      retrievalAppendix: async () => {
        appendixCalls += 1;
        return { role: "assistant", content: "[Retrieval appendix]\n- node omitted-node" };
      },
    };
    const compacted = await compact(
      messages,
      { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
      sources,
      {
        compactAt: noLimit,
        leaveOutAt: noLimit,
      },
    );
    expect(appendixCalls).toBe(1);
    expect(compacted.messages.at(-2)).toEqual({
      role: "assistant",
      content: "[Retrieval appendix]\n- node omitted-node",
    });
    expect(compacted.messages.at(-1)).toEqual({ role: "user", content: "current question" });

    let intactCalls = 0;
    await compact(
      [{ role: "user", content: "uncompacted" }],
      { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
      { ...sources, retrievalAppendix: async () => ((intactCalls += 1), null) },
      { compactAt: noLimit, leaveOutAt: noLimit },
    );
    expect(intactCalls).toBe(0);

    const fallback = await compact(
      messages,
      { manual: { clearedThrough: 0, summarizedTurns: 0 }, blocks: [] },
      {
        ...sources,
        retrievalAppendix: async () => Promise.reject(new Error("search unavailable")),
      },
      { compactAt: noLimit, leaveOutAt: noLimit },
    );
    expect(fallback.messages.at(-1)).toEqual({ role: "user", content: "current question" });
  });

  test("keeps the provider request user-last when retrieval adds an appendix", async () => {
    const { runtime } = await testRuntime();
    const metadata = await runtime.runPromise(
      Effect.map(ChatState, (state) => state.persistence.stores.metadata),
    );
    const messages: ModelMessage[] = [
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "old-1",
            type: "function",
            function: { name: "run_shell", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "old-1", content: "large earlier output" },
      { role: "assistant", content: "done" },
      { role: "user", content: "current question" },
    ];
    const sent = await firstSent(
      messages,
      compaction(
        metadata,
        {
          toolResultIds: () => new Map([["old-1", "omitted-node"]]),
          nodeText: () => null,
          retrievalAppendix: async () => ({
            role: "assistant",
            content: "[Retrieval appendix]",
          }),
        },
        { compactAt: noLimit, leaveOutAt: noLimit },
      ),
    );

    expect(sent.at(-2)).toEqual({ role: "assistant", content: "[Retrieval appendix]" });
    expect(sent.at(-1)).toEqual({ role: "user", content: "current question" });
  });

  test("/compact summarizes earlier turns and clears answered output for the runs that follow", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, project, session } = context;
    await context.provider!.select(runtime);
    const { agent, nodes, stores } = await runtime.runPromise(
      Effect.all({
        agent: AgentChat,
        nodes: Nodes,
        stores: Effect.map(ChatState, (state) => state.persistence.stores),
      }),
    );
    const { userNodes, messages, toolOutput, toolResult } = conversation(
      nodes,
      { projectId: project.id, sessionId: session.id },
      ["모두 통과했어요.", "네", "네", "네", "네"],
    );
    await stores.messages.saveThread(session.id, messages);
    const compact = async (holder: string | null) => {
      const response = await runtime.runPromise(agent.compact(session.id, holder));
      return { status: response.status, body: decodeCompact(await response.json()) };
    };

    await runtime.runPromise(agent.lease(session.id, "tab-a", "claim"));
    expect((await runtime.runPromise(agent.compact(session.id, "tab-b"))).status).toBe(423);
    expect((await runtime.runPromise(agent.compact("no-such-session", "tab-a"))).status).toBe(404);
    const first = await compact("tab-a");
    expect(first.status).toBe(200);
    // The latest two stay raw. Answered tool output is already pointerized by automatic compaction.
    expect(first.body).toMatchObject({ cleared: 0, summarizedTurns: 4, summaryFailed: false });
    expect(first.body.tokensAfter).toBeLessThan(first.body.tokensBefore);
    expect((await compact("tab-a")).body).toEqual({
      cleared: 0,
      summarizedTurns: 0,
      summaryFailed: false,
      tokensBefore: first.body.tokensAfter,
      tokensAfter: first.body.tokensAfter,
    });

    // The next question gets the summary, however small the conversation.
    const sent = await firstSent(
      [...messages, { role: "assistant", content: "네" }, { role: "user", content: "다음 질문" }],
      compaction(stores.metadata, sourcesOf(nodes, session.id), {
        compactAt: noLimit,
        leaveOutAt: noLimit,
      }),
      session.id,
    );
    expect(sent[0]).toEqual({
      role: "assistant",
      content: expect.stringContaining(`- 사용자 턴 4개 (node ${userNodes[0]!.id})`),
    });
    expect(sent[1]).toEqual({ role: "user", content: "질문 5" });
    expect(JSON.stringify(sent)).not.toContain(toolResult.id);
    // The saved conversation still has everything.
    const kept = await stores.messages.loadThread(session.id);
    expect(kept.find((message) => message.role === "tool")?.content).toBe(toolOutput);
  });

  test("reports prompt cache usage across consecutive requests and distinguishes zero", async () => {
    const setup = await testRuntime({
      testProvider: {
        responder: (invocation) => ({
          text: "ok",
          usage: {
            promptTokens: 120,
            completionTokens: 5,
            totalTokens: 125,
            promptTokensDetails: { cachedTokens: invocation.index === 0 ? 30 : 0 },
          },
        }),
      },
    });
    const { runtime, session } = setup;
    await setup.provider!.select(runtime);
    const agent = await runtime.runPromise(AgentChat);
    const status = async () =>
      decodeStatus(await (await runtime.runPromise(agent.status(session.id, null))).json()).context;
    const run = async (runId: string) => {
      const response = await runtime.runPromise(
        agent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: session.id,
              runId,
              messages: [{ id: `${runId}-message`, role: "user", content: "hello" }],
              tools: [],
              context: [],
            }),
          }),
          session.id,
        ),
      );
      return (await response.text())
        .split("\n")
        .flatMap((line) =>
          line.startsWith("data: ") ? [Schema.decodeUnknownSync(StreamEvent)(line.slice(6))] : [],
        );
    };

    expect(await status()).toEqual({
      usedTokens: null,
      cachedTokens: null,
      cacheRatio: null,
      compactionStage: null,
      windowTokens: 200_000,
      compactAtTokens: 50_000,
    });

    const firstEvents = await run("run-1");
    expect(
      firstEvents.some((event) => event.type === "CUSTOM" && event.name === "memory-agent.context"),
    ).toBe(true);
    expect(await status()).toMatchObject({
      usedTokens: 120,
      cachedTokens: 30,
      cacheRatio: 0.25,
      compactionStage: "none",
    });

    await run("run-2");
    expect(await status()).toMatchObject({
      usedTokens: 120,
      cachedTokens: 0,
      cacheRatio: 0,
      compactionStage: "none",
    });
    const ledger = await runtime.runPromise(ApiUsage);
    expect(ledger.byRootSession(session.id)).toMatchObject({
      responses: 2,
      inputTokens: 240,
      outputTokens: 10,
      cacheReadTokens: 30,
      uncachedInputTokens: 210,
    });
  });

  test("counts Korean closer to how models do than characters / 4", () => {
    expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
    expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
  });
});
