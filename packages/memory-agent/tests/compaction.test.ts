import { chat, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { clearedOutput, compactionFor, estimateTokens } from "../src/agent/compaction.ts";
import { Nodes } from "../src/memory/nodes.ts";
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

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // drain
  }
}

describe("compaction", () => {
  test("clears tool output the model already answered from, and keeps the run's own whole", async () => {
    const { runtime, project, session } = await testRuntime();
    const { nodes, tools } = await runtime.runPromise(
      Effect.all({
        nodes: Nodes,
        tools: Effect.map(MemoryTools, (memory) => memory.forProject(project.id)),
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
    await drain(
      chat({
        adapter,
        messages,
        tools,
        middleware: [
          middleware,
          // The log (about 4,500 tokens) is over budget; the page read_evidence returns in this run
          // (about 3,000) is not.
          compactionFor(() => nodes.toolResultIds(session.id), 4_000),
        ],
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

  test("leaves out the oldest messages, pointing to memory, when clearing is not enough", async () => {
    const long = "배포 절차를 설명해요. ".repeat(100);
    const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, content: `질문 ${index}: ${long}` },
      { role: "assistant" as const, content: `답 ${index}: ${long}` },
    ]).flat();
    messages.push({ role: "user", content: "마지막 질문" });
    const adapter = new ScriptedTextAdapter([{ text: "답" }]);
    await drain(
      chat({
        adapter,
        messages,
        middleware: [compactionFor(() => new Map(), 3_000)],
      }),
    );

    const sent = adapter.invocations[0]?.messages ?? [];
    expect(sent.length).toBeLessThan(messages.length);
    expect(sent[0]?.content).toContain("find_memory");
    expect(sent.at(-1)).toEqual({ role: "user", content: "마지막 질문" });
  });

  test("counts Korean closer to how models do than characters / 4", () => {
    expect(estimateTokens({ role: "user", content: "가나다abcd" })).toBe(4);
    expect(estimateTokens({ role: "user", content: "abcdefgh" })).toBe(2);
  });
});
