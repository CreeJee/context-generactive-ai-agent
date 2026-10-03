import { maxIterations, toolDefinition, type StreamChunk } from "@tanstack/ai";
import { expect, test } from "vite-plus/test";
import {
  createChatExecution,
  type ChatExecutionOptions,
  type ChatExecutionTurn,
} from "../src/agent/chat-execution.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";

test("owner capabilities override untyped turn fields without rebuilding owner input", () => {
  const adapter = new ScriptedTextAdapter([{ text: "unused" }]);
  const controller = new AbortController();
  const messages: ChatExecutionTurn<ScriptedTextAdapter>["messages"] = [];
  const tools: NonNullable<ChatExecutionOptions<ScriptedTextAdapter>["tools"]> = [];
  const middleware: NonNullable<ChatExecutionOptions<ScriptedTextAdapter>["middleware"]> = [];
  let received: ChatExecutionOptions<ScriptedTextAdapter> | undefined;
  const stream = (async function* () {})();
  const execution = createChatExecution<ScriptedTextAdapter>((options) => {
    received = options;
    return stream;
  });
  // Simulates JavaScript callers supplying fields excluded from the typed turn contract.
  const turn = {
    messages,
    runId: "owner-run",
    adapter: new ScriptedTextAdapter([{ text: "unused" }]),
    tools: ["untrusted"],
    middleware: ["untrusted"],
    abortController: new AbortController(),
    outputSchema: "untrusted",
    stream: false,
  };
  expect(
    execution.execute(turn, {
      model: { adapter },
      tools,
      middleware,
      stream: { abortController: controller },
    }),
  ).toBe(stream);
  expect(received?.adapter).toBe(adapter);
  expect(received?.messages).toBe(messages);
  expect(received?.tools).toBe(tools);
  expect(received?.middleware).toBe(middleware);
  expect(received?.abortController).toBe(controller);
  expect(received?.runId).toBe("owner-run");
  expect(received?.outputSchema).toBeUndefined();
  expect(received?.stream).toBe(true);
});

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("execution runs the complete tool/model loop with owner middleware and run identity", async () => {
  const adapter = new ScriptedTextAdapter([
    { toolCalls: [{ id: "call-1", name: "owner_read", arguments: "{}" }] },
    { text: "read completed" },
  ]);
  let calls = 0;
  let finished = 0;
  const tool = toolDefinition({
    name: "owner_read",
    description: "Owner capability",
  }).server(() => {
    calls++;
    return "owner result";
  });
  const chunks = await collect(
    createChatExecution<ScriptedTextAdapter>().execute(
      {
        messages: [{ role: "user", content: "read" }],
        systemPrompts: ["owner prompt"],
        threadId: "thread-1",
        runId: "run-1",
        parentRunId: "parent-1",
      },
      {
        model: { adapter, agentLoopStrategy: maxIterations(3) },
        tools: [tool],
        middleware: [
          {
            name: "owner-record",
            onFinish: () => {
              finished++;
            },
          },
        ],
        stream: { abortController: new AbortController() },
      },
    ),
  );
  expect(calls).toBe(1);
  expect(finished).toBe(1);
  expect(adapter.invocations).toHaveLength(2);
  expect(adapter.invocations[0]).toMatchObject({
    runId: "run-1",
    threadId: "thread-1",
    systemPrompts: ["owner prompt"],
    toolNames: ["owner_read"],
  });
  expect(chunks.some((chunk) => chunk.type === "TOOL_CALL_RESULT")).toBe(true);
  expect(
    chunks.some(
      (chunk) => chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta === "read completed",
    ),
  ).toBe(true);
});

test("owner stream cancellation reaches the full loop and owner abort middleware", async () => {
  let aborted = 0;
  const controller = new AbortController();
  const adapter = new ScriptedTextAdapter(() => {
    controller.abort();
    return { text: "must not emit" };
  });
  const chunks = await collect(
    createChatExecution<ScriptedTextAdapter>().execute(
      { threadId: "cancel-thread", runId: "cancel-run", messages: [] },
      {
        model: { adapter },
        tools: [],
        middleware: [
          {
            name: "owner-abort",
            onAbort: () => {
              aborted++;
            },
          },
        ],
        stream: { abortController: controller },
      },
    ),
  );
  expect(controller.signal.aborted).toBe(true);
  expect(chunks.some((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")).toBe(false);
  expect(aborted).toBe(1);
});
