import { it } from "@effect/vitest";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Cause, Effect, Stream } from "effect";
import { expect } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import { makeOpenAICompatibleSettings } from "../src/providers/openai-compatible.ts";

it.effect(
  "streams compatible tool calls and refuses unsolicited calls when tools are disabled",
  () =>
    Effect.gen(function* () {
      let saved: Settings = {};
      const wire =
        'data: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"manual","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"id":"tool","object":"chat.completion.chunk","created":1,"model":"manual","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
      const api = makeOpenAICompatibleSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: () => ({ get: () => Promise.resolve(null), set: () => Promise.resolve() }),
        fetcher: () =>
          Promise.resolve(new Response(wire, { headers: { "Content-Type": "text/event-stream" } })),
      });
      const model = { id: "manual", contextWindow: 8192, outputBudget: 512, toolCalling: true };
      const id = (yield* api.create({ baseUrl: "http://localhost:8000/v1" })).accounts[0]?.id ?? "";
      yield* api.saveModel(id, model);
      const selection = yield* api.services.models.select("manual");
      const collect = Effect.fnUntraced(function* () {
        return yield* Stream.fromAsyncIterable(
          (yield* api.runtime).adapter(selection).chatStream({
            threadId: "thread",
            logger: resolveDebugOption(false),
            model: "manual",
            messages: [{ role: "user", content: "lookup" }],
          }),
          (cause) => new Cause.UnknownError(cause),
        ).pipe(
          Stream.map((chunk) => chunk.type),
          Stream.runCollect,
        );
      });
      expect(yield* collect()).toContain("TOOL_CALL_START");
      yield* api.saveModel(id, { ...model, toolCalling: false });
      const failed = yield* Effect.flip(collect());
      expect(failed.cause).toBeInstanceOf(Error);
      expect(failed.cause).toHaveProperty(
        "message",
        expect.stringContaining("tool calling is disabled"),
      );
    }),
);
