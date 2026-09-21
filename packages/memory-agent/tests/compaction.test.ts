import { randomUUID } from "node:crypto";
import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import {
  clearedOutput,
  compact,
  compaction,
  estimateTokens,
  turnSummariesNamespace,
  type Budget,
  type CompactionSources,
} from "../src/agent/compaction.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
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

describe("compaction", () => {
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
  });

  test("counts Korean closer to how models do than characters / 4", () => {
    expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
    expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
  });
});
