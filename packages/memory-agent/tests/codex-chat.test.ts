import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chat, toolDefinition, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexChat } from "../src/codex/chat.ts";
import { toCodexTurnInput } from "../src/codex/history.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { toToolSchema } from "../src/tools/schema.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function chatRuntime() {
  const storage = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-codex-chat-")));
  const runtime = ManagedRuntime.make(
    CodexChat.layer.pipe(
      Layer.provideMerge(
        CodexAppServer.withCommand({ executable: process.execPath, args: [fakeServer] }),
      ),
      Layer.provideMerge(StorageRoot.layer(storage)),
    ),
  );
  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(storage, { recursive: true, force: true });
  });
  return runtime;
}

const executed: string[] = [];
const getWeather = toolDefinition({
  name: "get_weather",
  description: "Current weather for one city.",
  inputSchema: toToolSchema(Schema.Struct({ city: Schema.String })),
}).server(({ city }) => {
  executed.push(city);
  return `${city}: sunny`;
});

const Log = Schema.Struct({
  log: Schema.Array(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
});

async function run(runtime: ReturnType<typeof chatRuntime>, messages: ModelMessage[]) {
  const codexChat = await runtime.runPromise(CodexChat);
  const chunks: StreamChunk[] = [];
  for await (const chunk of chat({
    adapter: codexChat.adapter({ model: "fast-1", reasoningEffort: "low" }),
    messages,
    tools: [getWeather],
  }))
    chunks.push(chunk);
  const text = chunks
    .flatMap((chunk) => (chunk.type === "TEXT_MESSAGE_CONTENT" ? [chunk.delta] : []))
    .join("");
  const log = await runtime.runPromise(
    Effect.flatMap(CodexAppServer, (codex) => codex.request("test/log", undefined, Log)),
  );
  const methods = log.log.map((entry) => entry.method);
  return { chunks, text, methods, log: log.log };
}

describe("toCodexTurnInput", () => {
  test("injects prior messages as Responses items and keeps a trailing user message as input", () => {
    expect(
      toCodexTurnInput([
        { role: "user", content: "서울 날씨?" },
        {
          role: "assistant",
          content: "확인할게요.",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Seoul"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "Seoul: sunny" },
        { role: "user", content: [{ type: "text", content: "부산은?" }] },
      ]),
    ).toEqual({
      history: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "서울 날씨?" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "확인할게요." }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "get_weather",
          arguments: '{"city":"Seoul"}',
        },
        { type: "function_call_output", call_id: "c1", output: "Seoul: sunny" },
      ],
      input: [{ type: "text", text: "부산은?", text_elements: [] }],
    });
  });
});

describe("CodexTextAdapter", () => {
  test("streams a plain answer", async () => {
    const result = await run(chatRuntime(), [{ role: "user", content: "say hello" }]);
    expect(result.text).toBe("Hello from fast-1");
    expect(result.chunks.map((chunk) => chunk.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  test("runs a codex tool request through TanStack and continues the same codex turn", async () => {
    executed.length = 0;
    const result = await run(chatRuntime(), [{ role: "user", content: "what is the weather" }]);
    expect(executed).toEqual(["Seoul"]);
    expect(result.text).toBe("Weather says Seoul: sunny");
    // One thread and one turn: the tool result went back into the waiting turn.
    expect(result.methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(result.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    const started = result.log.find((entry) => entry.method === "thread/start");
    expect(started?.params).toMatchObject({
      ephemeral: true,
      allowProviderModelFallback: false,
      dynamicTools: [{ type: "function", name: "get_weather", inputSchema: { type: "object" } }],
    });
  });

  test("hands parallel codex tool requests to TanStack in one step", async () => {
    executed.length = 0;
    const result = await run(chatRuntime(), [{ role: "user", content: "parallel weather" }]);
    expect(executed.toSorted()).toEqual(["Busan", "Seoul"]);
    expect(result.text).toBe("Both: Seoul: sunny | Busan: sunny");
    expect(result.methods.filter((method) => method === "thread/start")).toHaveLength(1);
  });

  test("continues from injected tool results when no codex turn is waiting", async () => {
    const result = await run(chatRuntime(), [
      { role: "user", content: "what is the weather" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Seoul"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: "Seoul: approved and sunny" },
    ]);
    expect(result.text).toBe("Resumed with Seoul: approved and sunny");
    const turnStart = result.log.find((entry) => entry.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ input: [], effort: "low", model: "fast-1" });
    const inject = result.log.find((entry) => entry.method === "thread/inject_items");
    expect(inject?.params).toMatchObject({
      items: [
        { type: "message", role: "user" },
        { type: "function_call", call_id: "call-1" },
        { type: "function_call_output", call_id: "call-1", output: "Seoul: approved and sunny" },
      ],
    });
  });

  test("surfaces a failed model request as a run error", async () => {
    const result = await run(chatRuntime(), [{ role: "user", content: "please fail" }]).then(
      (finished) => ({ kind: "finished" as const, chunks: finished.chunks }),
      (error: Error) => ({ kind: "threw" as const, error }),
    );
    const failed =
      result.kind === "threw" || result.chunks.some((chunk) => chunk.type === "RUN_ERROR");
    expect(failed).toBe(true);
  });
});
