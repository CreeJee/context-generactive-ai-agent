import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chat } from "@tanstack/ai";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { once } from "node:events";
import { Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { Settings } from "../src/config/global-config.ts";
import { sqliteChatPersistence } from "../src/chat-state/persistence.ts";
import { migrations } from "../src/db/migrations.ts";
import {
  makeOpenAICompatibleSettings,
  validateCompatibleConfiguration,
} from "../src/providers/openai-compatible.ts";

const configuration = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "manual-model",
  contextWindow: 8192,
  outputBudget: 512,
  toolCalling: true,
};
const ChatRequest = Schema.Struct({
  max_tokens: Schema.optional(Schema.Int),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});
function fixture(fetcher?: typeof fetch, initial: Settings = {}) {
  let saved: Settings = initial;
  let key: string | null = null;
  const config = {
    read: Effect.sync(() => saved),
    update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
  };
  const keys = {
    get: async () => key,
    set: async (value: string | null) => {
      key = value;
    },
  };
  return {
    api: makeOpenAICompatibleSettings(config, keys, fetcher),
    restore: () => makeOpenAICompatibleSettings(config, keys, fetcher),
    saved: () => saved,
  };
}
describe("OpenAI compatible settings", () => {
  it("keeps the legacy omitted effort as the server default when discovering off support", async () => {
    const f = fixture(
      async (url) => {
        const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        return address.endsWith("/api/v1/models")
          ? Response.json({
              models: [
                {
                  type: "llm",
                  key: configuration.model,
                  capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
                },
              ],
            })
          : Response.json({ data: [{ id: configuration.model }] });
      },
      {
        provider: "openai-compatible",
        model: configuration.model,
        reasoningEffort: "none",
        openaiCompatible: configuration,
      },
    );
    await Effect.runPromise(f.api.services.models.list);
    expect(f.saved().reasoningEffort).toBe("default");
    await Effect.runPromise(f.api.services.models.select(configuration.model, "none"));
    await Effect.runPromise(f.api.services.models.list);
    expect(f.saved().reasoningEffort).toBe("none");
  });
  it("discovers model-specific reasoning levels, restores selection and sends only supported effort", async () => {
    const Body = Schema.fromJsonString(
      Schema.Struct({ reasoning_effort: Schema.optional(Schema.String) }),
    );
    const bodies: (typeof Body.Type)[] = [];
    const f = fixture(async (url, init) => {
      const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (address.endsWith("/api/v1/models"))
        return Response.json({
          models: [
            {
              type: "llm",
              key: configuration.model,
              capabilities: {
                reasoning: { allowed_options: ["off", "low", "xhigh", "on"], default: "xhigh" },
              },
            },
          ],
        });
      if (address.endsWith("/models"))
        return Response.json({ data: [{ id: configuration.model }] });
      bodies.push(Schema.decodeUnknownSync(Body)(init?.body));
      return new Response(
        'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"manual-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    await Effect.runPromise(f.api.update(configuration));
    expect(
      (await Effect.runPromise(f.api.services.models.list))[0]?.supportedReasoningEfforts,
    ).toEqual(["default", "none", "low", "xhigh"]);
    await expect(
      Effect.runPromise(f.api.services.models.select(configuration.model, "medium")),
    ).rejects.toThrow();
    for (const effort of ["xhigh", "default"]) {
      const selection = await Effect.runPromise(
        f.api.services.models.select(configuration.model, effort),
      );
      expect(await Effect.runPromise(f.restore().services.models.selected)).toEqual(selection);
      const adapter = f.api.services.runtime.adapter(selection);
      try {
        for await (const _chunk of adapter.chatStream({
          logger: resolveDebugOption(false),
          model: configuration.model,
          messages: [{ role: "user", content: "hi" }],
        })) {
          /* consume */
        }
      } finally {
        adapter.releaseRun?.();
      }
    }
    expect(bodies[0]?.reasoning_effort).toBe("xhigh");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    await Effect.runPromise(f.api.services.models.select(configuration.model, "xhigh"));
    await Effect.runPromise(f.api.update(configuration));
    expect((await Effect.runPromise(f.restore().services.models.selected))?.reasoningEffort).toBe(
      "xhigh",
    );
    await Effect.runPromise(f.api.update({ ...configuration, model: "other-model" }));
    expect((await Effect.runPromise(f.restore().services.models.selected))?.reasoningEffort).toBe(
      "default",
    );
  });
  it.each(["reasoning_content", "reasoning"])(
    "streams and restores %s separately from the final answer",
    async (field) => {
      const sqlite = new DatabaseSync(":memory:");
      for (const step of migrations) sqlite.exec(step);
      const persistence = sqliteChatPersistence(sqlite);
      const f = fixture(async () => {
        const chunks = [
          ...[{ [field]: "Compare the values." }, { content: "The answer is 42." }].map(
            (delta) => ({
              id: "reasoning-test",
              object: "chat.completion.chunk",
              created: 1,
              model: configuration.model,
              choices: [{ index: 0, delta, finish_reason: null }],
            }),
          ),
          {
            id: "reasoning-test",
            object: "chat.completion.chunk",
            created: 1,
            model: configuration.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      });
      await Effect.runPromise(f.api.update(configuration));
      const adapter = f.api.services.runtime.adapter({
        provider: "openai-compatible",
        model: configuration.model,
        reasoningEffort: "default",
      });
      try {
        const events = [];
        for await (const event of chat({
          adapter,
          messages: [{ role: "user", content: "Answer the question." }],
          threadId: "reasoning",
          runId: "reasoning-run",
          middleware: [withPersistence(persistence)],
        }))
          events.push(event);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "REASONING_MESSAGE_CONTENT",
            delta: "Compare the values.",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "The answer is 42." }),
        );
        const response = await reconstructChat(
          persistence,
          new Request("http://localhost/chat?threadId=reasoning"),
        );
        const restored = await response.json();
        expect(JSON.stringify(restored)).toContain('"type":"thinking"');
        expect(JSON.stringify(restored)).toContain("Compare the values.");
        expect(JSON.stringify(restored)).toContain("The answer is 42.");
      } finally {
        adapter.releaseRun?.();
        sqlite.close();
      }
    },
  );
  it("validates endpoint, limits, and never persists keys", async () => {
    const f = fixture();
    const status = await Effect.runPromise(
      f.api.update({ ...configuration, apiKey: "test-only-key" }),
    );
    expect(status.hasApiKey).toBe(true);
    expect(JSON.stringify(f.saved())).not.toContain("[redacted:credential]");
    await Effect.runPromise(f.api.update(configuration));
    expect((await Effect.runPromise(f.api.status)).hasApiKey).toBe(true);
    const rejected = await Effect.runPromise(
      Effect.flip(
        f.api.update({
          ...configuration,
          baseUrl: "http://127.0.0.1:9876/v1",
        }),
      ),
    );
    expect(rejected.operation).toBe("validation");
    await Effect.runPromise(f.api.update({ ...configuration, apiKey: null }));
    expect((await Effect.runPromise(f.api.status)).hasApiKey).toBe(false);
    for (const patch of [
      { baseUrl: "file:///tmp/server" },
      { baseUrl: "https://user:password@example.com/v1" },
      { contextWindow: 0 },
      { outputBudget: 8192 },
      { outputBudget: -1 },
    ])
      expect(() => validateCompatibleConfiguration({ ...configuration, ...patch })).toThrow();
  });
  it("restores a manual model without discovery and isolates discovery errors", async () => {
    const f = fixture(async () => new Response("private provider diagnostic", { status: 503 }));
    await Effect.runPromise(f.api.update(configuration));
    await Effect.runPromise(f.api.services.models.select(configuration.model));
    expect(await Effect.runPromise(f.restore().services.models.selected)).toEqual({
      provider: "openai-compatible",
      model: "manual-model",
      reasoningEffort: "default",
    });
    await expect(Effect.runPromise(f.api.listModels)).rejects.toThrow();
    expect((await Effect.runPromise(f.api.services.models.list))[0]?.id).toBe("manual-model");
    await expect(Effect.runPromise(f.api.services.models.select("missing"))).rejects.toThrow();
    expect(f.api.services.runtime.contextWindow(configuration.model)).toBe(7680);
  });
  it("interrupting discovery aborts the actual fetch", async () => {
    let onRequest: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      onRequest = resolve;
    });
    let signal: AbortSignal | undefined;
    const f = fixture(async (_url, init) => {
      signal = init?.signal ?? undefined;
      onRequest?.();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    await Effect.runPromise(f.api.update(configuration));
    const fiber = Effect.runFork(f.api.listModels);
    await requested;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
  });
  it("times out discovery with a typed failure and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    const f = fixture(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    await Effect.runPromise(f.api.update(configuration));
    const error = await Effect.runPromise(Effect.flip(f.api.listModels));
    expect(error.operation).toBe("models");
    expect(signal?.aborted).toBe(true);
  }, 20_000);
  it("reports an uncertain keyring write as partial without writing settings", async () => {
    let saved: Settings = {};
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: async () => null,
        set: async () => {
          throw new Error("private keyring detail");
        },
      },
    );
    const result = await Effect.runPromise(
      Effect.flip(api.update({ ...configuration, apiKey: "secret" })),
    );
    expect(result.operation).toBe("partial");
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect(saved.openaiCompatible).toBeUndefined();
  });
  it("reports config failure after a key write as partial without persisting a secret", async () => {
    let key: string | null = null;
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.succeed({}),
        update: () =>
          Effect.sync(() => {
            throw new Error("private config detail");
          }),
      },
      {
        get: async () => key,
        set: async (value) => {
          key = value;
        },
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(api.update({ ...configuration, apiKey: "secret" })),
    );
    expect(error.operation).toBe("partial");
    expect(key).toContain("secret");
    expect(JSON.stringify(error)).not.toContain("secret");
  });
  it("never sends a new key to the old endpoint while settings update is in flight", async () => {
    let saved: Settings = {};
    let key: string | null = null;
    let unblock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: async () => key,
        set: async (value) => {
          if (value?.includes('"key":"second"')) {
            entered?.();
            await gate;
          }
          key = value;
        },
      },
      async (url, init) => {
        seen.push({
          url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    );
    await Effect.runPromise(api.update({ ...configuration, apiKey: "first" }));
    const pending = Effect.runPromise(
      api.update({
        ...configuration,
        baseUrl: "http://127.0.0.1:9876/v1",
        apiKey: "second",
      }),
    );
    await writing;
    const probe = Effect.runPromise(api.test);
    unblock?.();
    await pending;
    await probe;
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:9876/v1/chat/completions",
        authorization: "Bearer second",
      },
    ]);
  });
  it("keeps the old endpoint unauthenticated after an uncertain changed key", async () => {
    let saved: Settings = {};
    let key: string | null = null;
    let rejectWrite = false;
    const headers: Array<string | null> = [];
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: async () => key,
        set: async (value) => {
          key = value;
          if (rejectWrite) throw new Error("uncertain keyring outcome");
        },
      },
      async (_url, init) => {
        headers.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    );
    await Effect.runPromise(api.update({ ...configuration, apiKey: "first" }));
    rejectWrite = true;
    const error = await Effect.runPromise(
      Effect.flip(
        api.update({
          ...configuration,
          baseUrl: "http://127.0.0.1:9876/v1",
          apiKey: "second",
        }),
      ),
    );
    expect(error.operation).toBe("partial");
    // A stored key remains visible for explicit removal, but is not sent to the old URL.
    expect((await Effect.runPromise(api.status)).hasApiKey).toBe(true);
    await Effect.runPromise(api.test);
    expect(headers).toEqual([null]);
  });
  it("updates an active model selection when its manual model ID changes", async () => {
    const f = fixture();
    await Effect.runPromise(f.api.update(configuration));
    await Effect.runPromise(f.api.services.models.select(configuration.model));
    await Effect.runPromise(f.api.update({ ...configuration, model: "changed-manual-model" }));
    expect(await Effect.runPromise(f.api.services.models.selected)).toEqual({
      provider: "openai-compatible",
      model: "changed-manual-model",
      reasoningEffort: "default",
    });
  });
  it("serializes model selection with an in-flight settings update", async () => {
    let saved: Settings = {};
    let unblock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: async () => null,
        set: async () => {
          entered?.();
          await gate;
        },
      },
    );
    await Effect.runPromise(api.update(configuration));
    const changing = Effect.runPromise(
      api.update({
        ...configuration,
        model: "new-model",
        apiKey: "key",
      }),
    );
    await writing;
    const selection = Effect.runPromise(
      Effect.flip(api.services.models.select(configuration.model)),
    );
    unblock?.();
    await changing;
    expect((await selection)._tag).toBe("ModelUnavailable");
    expect(await Effect.runPromise(api.services.models.selected)).toBeNull();
    expect((await Effect.runPromise(api.services.models.list))[0]?.id).toBe("new-model");
  });
  it("releases a run even when the keyring read never settles", async () => {
    let saved: Settings = { openaiCompatible: configuration };
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: () => new Promise<string | null>(() => {}),
        set: async () => {},
      },
      async () => {
        throw new Error("must not reach network");
      },
    );
    const adapter = api.services.runtime.adapter({
      provider: "openai-compatible",
      model: configuration.model,
      reasoningEffort: "default",
    });
    const consumed = (async () => {
      for await (const _chunk of adapter.chatStream({
        logger: resolveDebugOption(false),
        model: configuration.model,
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
    })();
    adapter.releaseRun?.();
    await expect(
      Promise.race([
        consumed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("not released")), 1000),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
  it("releaseRun aborts an in-flight compatible SDK request", async () => {
    let started: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const f = fixture(async (_url, init) => {
      signal = init?.signal ?? undefined;
      started?.();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    await Effect.runPromise(f.api.update(configuration));
    const adapter = f.api.services.runtime.adapter({
      provider: "openai-compatible",
      model: configuration.model,
      reasoningEffort: "default",
    });
    const iterator = adapter
      .chatStream({
        logger: resolveDebugOption(false),
        model: configuration.model,
        messages: [{ role: "user", content: "hi" }],
      })
      [Symbol.asyncIterator]();
    const result = iterator.next();
    await requested;
    adapter.releaseRun?.();
    expect(signal?.aborted).toBe(true);
    await result;
    await iterator.return?.();
  });
  it("pins endpoint, model, key, and budget to an adapter across later settings edits", async () => {
    let saved: Settings = {};
    let key: string | null = null;
    const observed: Array<{ url: string; authorization: string | null; body: string }> = [];
    const api = makeOpenAICompatibleSettings(
      {
        read: Effect.sync(() => saved),
        update: (patch: Partial<Settings>) => Effect.sync(() => (saved = { ...saved, ...patch })),
      },
      {
        get: async () => key,
        set: async (value) => {
          key = value;
        },
      },
      async (url, init) => {
        observed.push({
          url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
          authorization: new Headers(init?.headers).get("authorization"),
          body: Schema.decodeUnknownSync(Schema.String)(init?.body ?? "{}"),
        });
        return new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"manual-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    await Effect.runPromise(api.update({ ...configuration, apiKey: "first" }));
    const adapter = api.services.runtime.adapter({
      provider: "openai-compatible",
      model: configuration.model,
      reasoningEffort: "default",
    });
    await Effect.runPromise(
      api.update({
        ...configuration,
        baseUrl: "http://127.0.0.1:9876/v1",
        outputBudget: 128,
        apiKey: "second",
      }),
    );
    for await (const _chunk of adapter.chatStream({
      logger: resolveDebugOption(false),
      model: configuration.model,
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* consume */
    }
    adapter.releaseRun?.();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toContain("127.0.0.1:1234/v1/chat/completions");
    expect(observed[0]?.authorization).toBe("Bearer first");
    expect(JSON.parse(observed[0]?.body ?? "{}").max_tokens).toBe(512);
  });
  it("uses Chat Completions streaming with tools and an explicit output budget; off removes tools", async () => {
    const requests: Array<{
      path: string;
      authorization: string | undefined;
      body: typeof ChatRequest.Type;
    }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: Schema.decodeUnknownSync(Schema.fromJsonString(ChatRequest))(body || "{}"),
      });
      if (request.url === "/v1/models") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "discovered" }] }));
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      const toolsEnabled = requests.at(-1)?.body.tools !== undefined;
      const deltas = toolsEnabled
        ? [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_lookup",
                  type: "function",
                  function: { name: "lookup", arguments: "{" },
                },
              ],
            },
            { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
          ]
        : [{ role: "assistant", content: "OK" }];
      const chunks = [
        ...deltas.map((delta) => ({ delta, finish_reason: null })),
        {
          delta: {},
          finish_reason: toolsEnabled ? "tool_calls" : "stop",
        },
      ];
      response.end(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({
                id: "test",
                object: "chat.completion.chunk",
                created: 1,
                model: "manual-model",
                choices: [{ index: 0, ...chunk }],
              })}\n\n`,
          )
          .join("") + "data: [DONE]\n\n",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const f = fixture();
      const settings = { ...configuration, baseUrl: `http://127.0.0.1:${address.port}/v1` };
      await Effect.runPromise(f.api.update(settings));
      expect(await Effect.runPromise(f.api.listModels)).toEqual(["discovered"]);
      const selection = await Effect.runPromise(f.api.services.models.select(configuration.model));
      const tool = {
        name: "lookup",
        description: "Lookup",
        inputSchema: { type: "object", properties: {} },
      };
      const consume = async () => {
        const chunks = [];
        for await (const chunk of f.api.services.runtime.adapter(selection).chatStream({
          logger: resolveDebugOption(false),
          model: configuration.model,
          messages: [{ role: "user", content: "hello" }],
          tools: [tool],
        }))
          chunks.push(chunk);
        return chunks;
      };
      const toolChunks = await consume();
      expect(toolChunks).toContainEqual(
        expect.objectContaining({
          type: "TOOL_CALL_START",
          toolCallId: "call_lookup",
          toolCallName: "lookup",
        }),
      );
      expect(toolChunks).toContainEqual(
        expect.objectContaining({ type: "TOOL_CALL_END", toolCallId: "call_lookup" }),
      );
      expect(toolChunks).toContainEqual(
        expect.objectContaining({ type: "RUN_FINISHED", finishReason: "tool_calls" }),
      );
      expect(requests.at(-1)?.path).toBe("/v1/chat/completions");
      expect(requests.at(-1)?.body.max_tokens).toBe(512);
      expect(requests.at(-1)?.body.tools).toBeDefined();
      expect(requests.at(-1)?.authorization).toBeUndefined();
      await Effect.runPromise(f.api.update({ ...settings, toolCalling: false }));
      await consume();
      expect(requests.at(-1)?.body.tools).toBeUndefined();
      const adapter = f.api.services.runtime.adapter(selection);
      const before = requests.length;
      const chunks = [];
      for await (const chunk of adapter.chatStream({
        logger: resolveDebugOption(false),
        model: configuration.model,
        messages: [{ role: "user", content: "x".repeat(100_000) }],
      }))
        chunks.push(chunk);
      expect(chunks.some((chunk) => chunk.type === "RUN_ERROR")).toBe(true);
      expect(requests.length).toBe(before);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
