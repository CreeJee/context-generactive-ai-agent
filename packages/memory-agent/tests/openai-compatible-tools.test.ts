import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import { makeOpenAICompatibleSettings } from "../src/providers/openai-compatible.ts";

it("streams compatible tool calls and refuses unsolicited calls when tools are disabled", async () => {
  let saved: Settings = {};
  const wire =
    'data: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"manual","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"manual","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  const api = makeOpenAICompatibleSettings(
    {
      read: Effect.sync(() => saved),
      update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
    },
    { get: async () => null, set: async () => {} },
    async () => new Response(wire, { headers: { "Content-Type": "text/event-stream" } }),
  );
  const configuration = {
    baseUrl: "http://localhost:8000/v1",
    model: "manual",
    contextWindow: 8192,
    outputBudget: 512,
    toolCalling: true,
  };
  await Effect.runPromise(api.update(configuration));
  const selection = await Effect.runPromise(api.services.models.select("manual"));
  const collect = async () => {
    const types: string[] = [];
    for await (const chunk of api.services.runtime.adapter(selection).chatStream({
      logger: resolveDebugOption(false),
      model: "manual",
      messages: [{ role: "user", content: "lookup" }],
    }))
      types.push(chunk.type);
    return types;
  };
  expect(await collect()).toContain("TOOL_CALL_START");
  await Effect.runPromise(api.update({ ...configuration, toolCalling: false }));
  await expect(collect()).rejects.toThrow("tool calling is disabled");
});
