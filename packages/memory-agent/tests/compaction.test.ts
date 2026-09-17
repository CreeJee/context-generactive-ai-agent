import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import {
  clearedOutput,
  compaction,
  estimateTokens,
  turnSummariesNamespace,
  type Budget,
  type CompactionSources,
} from "../src/agent/compaction.ts";
import { contextUsageEvent } from "../src/agent/run-state.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Nodes, type Node } from "../src/memory/nodes.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { MemoryTools } from "../src/tools/memory.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

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

    // Six turns: the four latest stay, the two before them go as their summary.
    const summarized = await sent({ compactAt: 1_000, leaveOutAt: noLimit }, messages);
    expect(summarized[0]).toEqual({
      role: "assistant",
      content: expect.stringContaining("Turns 1-2:\n- 배포 절차를 정했다"),
    });
    expect(summarized[1]).toEqual({ role: "user", content: "질문 3" });
    expect(summarized.at(-1)).toEqual({ role: "user", content: "질문 6" });

    // Under budget, nothing changes.
    expect(await sent({ compactAt: noLimit, leaveOutAt: noLimit }, messages)).toEqual(messages);

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

  test("/compact summarizes earlier turns and clears answered output for the runs that follow", async () => {
    const { runtime, project, session } = await testRuntime({ codex: fakeCodex });
    await runtime.runPromise(Effect.flatMap(CodexModels, (models) => models.select("fast-1")));
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
    // The two turns before the latest four; the tool output was in the first of them.
    expect(first.body).toMatchObject({ cleared: 1, summarizedTurns: 2, summaryFailed: false });
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
      content: expect.stringContaining(`- 사용자 턴 2개 (node ${userNodes[0]!.id})`),
    });
    expect(sent[1]).toEqual({ role: "user", content: "질문 3" });
    expect(JSON.stringify(sent)).not.toContain(toolResult.id);
    // The saved conversation still has everything.
    const kept = await stores.messages.loadThread(session.id);
    expect(kept.find((message) => message.role === "tool")?.content).toBe(toolOutput);
  });

  test("a run reports how much of the model's context it read", async () => {
    const { runtime, session } = await testRuntime({ codex: fakeCodex });
    await runtime.runPromise(Effect.flatMap(CodexModels, (models) => models.select("fast-1")));
    const agent = await runtime.runPromise(AgentChat);
    const status = async () =>
      decodeStatus(await (await runtime.runPromise(agent.status(session.id, null))).json()).context;

    // Before any run: nothing read yet, and the window every offered model has.
    expect(await status()).toEqual({
      usedTokens: null,
      windowTokens: 258_400,
      compactAtTokens: 64_600,
    });

    const response = await runtime.runPromise(
      agent.handle(
        new Request("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session.id,
            runId: "run-1",
            messages: [{ id: "m1", role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        }),
        session.id,
      ),
    );
    const events = (await response.text())
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ") ? [Schema.decodeUnknownSync(StreamEvent)(line.slice(6))] : [],
      );
    // The fake model reads 10 tokens of a 200k window.
    const context = { usedTokens: 10, windowTokens: 200_000, compactAtTokens: 50_000 };
    expect(events).toContainEqual({ type: "CUSTOM", name: contextUsageEvent, value: context });
    expect(await status()).toEqual(context);
  });

  test("counts Korean closer to how models do than characters / 4", () => {
    expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
    expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
  });
});
