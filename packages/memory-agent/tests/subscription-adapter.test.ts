import { EventType, chat, toolDefinition, type TextOptions } from "@tanstack/ai";
import { InternalLogger } from "@tanstack/ai/adapter-internals";
import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  ProviderFeatureRejectedError,
  decodeProviderEvent,
  providerProtocols,
} from "../src/oauth/protocol.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import {
  SubscriptionTextAdapter,
  requestFingerprints,
  subscriptionRequest,
} from "../src/providers/subscription-adapter.ts";
import {
  createSubscriptionRuntime,
  subscriptionAgentLoop,
} from "../src/providers/subscription-runtime.ts";

const options = {
  systemPrompts: ["Follow the rules."],
  messages: [
    { role: "user", content: "hello" },
    // Older persisted tool-only messages can omit content at runtime despite the static type.
    JSON.parse(
      JSON.stringify({
        role: "assistant",
        content: undefined,
        thinking: [{ content: "reasoning text", signature: "signed" }],
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"x"}' },
          },
        ],
      }),
    ),
    { role: "tool", toolCallId: "call-1", content: "result" },
  ],
  tools: [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Pick<TextOptions<Record<string, never>>, "messages" | "systemPrompts" | "tools">;

const logger = new InternalLogger(
  {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
  {
    request: false,
    provider: false,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    errors: false,
    sandbox: false,
  },
);

describe("subscription model adapters", () => {
  test("fingerprints messages and tool definitions without retaining their contents", () => {
    const first = requestFingerprints(options);
    expect(requestFingerprints(options)).toEqual(first);
    expect(first.messageFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.toolFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toContain("Follow the rules");
    expect(JSON.stringify(first)).not.toContain("Look up a value");
    expect(
      requestFingerprints({ ...options, messages: [{ role: "user", content: "changed" }] })
        .messageFingerprint,
    ).not.toBe(first.messageFingerprint);
    expect(requestFingerprints({ ...options, tools: [] }).toolFingerprint).not.toBe(
      first.toolFingerprint,
    );

    const alphabetic = {
      name: "alpha",
      description: "Earlier by name",
      inputSchema: {
        type: "object",
        properties: { zeta: { type: "string" }, alpha: { type: "number" } },
      },
    };
    const forward = { ...options, tools: [options.tools[0]!, alphabetic] };
    const reversed = { ...options, tools: [alphabetic, options.tools[0]!] };
    expect(requestFingerprints(forward).toolFingerprint).toBe(
      requestFingerprints(reversed).toolFingerprint,
    );
    for (const provider of ["openai", "anthropic"] as const) {
      const selection = { provider, model: "model-1", reasoningEffort: "medium" };
      expect(subscriptionRequest(provider, selection, forward)).toBe(
        subscriptionRequest(provider, selection, reversed),
      );
      const request = JSON.parse(subscriptionRequest(provider, selection, forward));
      expect(request.tools.map((tool: { name: string }) => tool.name)).toEqual(["alpha", "lookup"]);
      const schema =
        provider === "openai" ? request.tools[0].parameters : request.tools[0].input_schema;
      expect(Object.keys(schema.properties)).toEqual(["zeta", "alpha"]);
    }
  });

  test("normalizes provider usage, errors, and encrypted reasoning", () => {
    expect(
      decodeProviderEvent(
        "openai",
        JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs-1",
            encrypted_content: "encrypted",
          },
        }),
      ),
    ).toEqual({
      type: "reasoning",
      id: "rs-1",
      encryptedContent: "encrypted",
    });
    expect(
      decodeProviderEvent(
        "openai",
        JSON.stringify({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 3 },
            },
          },
        }),
      ),
    ).toEqual({
      type: "usage",
      promptTokens: 9,
      completionTokens: 4,
      cachedPromptTokens: 3,
    });
    expect(
      decodeProviderEvent(
        "anthropic",
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signed" },
        }),
      ),
    ).toEqual({
      type: "reasoning-signature",
      index: 0,
      signature: "signed",
    });
    expect(
      decodeProviderEvent(
        "anthropic",
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "busy" },
        }),
      ),
    ).toEqual({
      type: "error",
      code: "overloaded_error",
      message: "busy",
    });
  });

  test("continues every tool boundary and refuses cross-provider adapter selection", async () => {
    const client = { async *stream() {} };
    const runtime = createSubscriptionRuntime("anthropic", client);
    expect(
      subscriptionAgentLoop({
        iterationCount: 12,
        toolCallCount: 12,
        lastTurnToolCallCount: 1,
        finishReason: "tool_calls",
        messages: [],
      }),
    ).toBe(true);
    expect(
      subscriptionAgentLoop({
        iterationCount: 13,
        toolCallCount: 12,
        lastTurnToolCallCount: 1,
        finishReason: "stop",
        messages: [],
      }),
    ).toBe(false);
    expect(await runtime.steer("thread", { role: "user", content: "later" })).toBe("no_turn");
    expect(() =>
      runtime.adapter({
        provider: "openai",
        model: "wrong-provider",
        reasoningEffort: "high",
      }),
    ).toThrow("Provider mismatch");
  });

  test("continues with tool results in a fresh provider request", async () => {
    const bodies: string[] = [];
    const client = {
      async *stream(body: string) {
        bodies.push(body);
        if (bodies.length === 1) {
          yield {
            type: "reasoning" as const,
            id: "rs-1",
            encryptedContent: "encrypted-reasoning",
          };
          yield {
            type: "tool-call" as const,
            id: "call-1",
            name: "lookup",
            arguments: { query: "x" },
          };
          return;
        }
        yield { type: "text" as const, text: "done" };
      },
    };
    const lookup = toolDefinition({
      name: "lookup",
      description: "Look up a value",
      inputSchema: toToolSchema(Schema.Struct({ query: Schema.String })),
    }).server(({ query }) => ({ query, found: true }));
    const runtime = createSubscriptionRuntime("openai", client);
    const chunks = [];
    for await (const chunk of chat({
      adapter: runtime.adapter({
        provider: "openai",
        model: "model-1",
        reasoningEffort: "high",
      }),
      agentLoopStrategy: runtime.agentLoop,
      messages: [{ role: "user", content: "find x" }],
      tools: [lookup],
      threadId: "thread-1",
      middleware: [runtime.runMiddleware()],
    }))
      chunks.push(chunk);

    expect(bodies).toHaveLength(2);
    const continuation = JSON.parse(bodies[1]!);
    expect(continuation.input).toContainEqual({
      type: "reasoning",
      id: "rs-1",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    });
    expect(continuation.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: '{"query":"x","found":true}',
    });
    expect(
      chunks
        .flatMap((chunk) => (chunk.type === EventType.TEXT_MESSAGE_CONTENT ? [chunk.delta] : []))
        .join(""),
    ).toBe("done");
  });

  test("round-trips Anthropic thinking signatures across a tool continuation", async () => {
    const bodies: string[] = [];
    const client = {
      async *stream(body: string) {
        bodies.push(body);
        if (bodies.length === 1) {
          yield { type: "reasoning-start" as const, index: 0 };
          yield {
            type: "reasoning-delta" as const,
            index: 0,
            delta: "private reasoning",
          };
          yield {
            type: "reasoning-signature" as const,
            index: 0,
            signature: "signed-reasoning",
          };
          yield { type: "content-block-end" as const, index: 0 };
          yield {
            type: "tool-call-start" as const,
            index: 1,
            id: "call-1",
            name: "lookup",
          };
          yield {
            type: "tool-call-arguments" as const,
            index: 1,
            delta: '{"query":"x"}',
          };
          yield { type: "content-block-end" as const, index: 1 };
          return;
        }
        yield { type: "text" as const, text: "done" };
      },
    };
    const lookup = toolDefinition({
      name: "lookup",
      description: "Look up a value",
      inputSchema: toToolSchema(Schema.Struct({ query: Schema.String })),
    }).server(({ query }) => ({ query, found: true }));
    const runtime = createSubscriptionRuntime("anthropic", client);
    for await (const _chunk of chat({
      adapter: runtime.adapter({
        provider: "anthropic",
        model: "model-1",
        reasoningEffort: "medium",
      }),
      agentLoopStrategy: runtime.agentLoop,
      messages: [{ role: "user", content: "find x" }],
      tools: [lookup],
      threadId: "thread-1",
      middleware: [runtime.runMiddleware()],
    })) {
      // Drain both model iterations.
    }

    expect(JSON.parse(bodies[1]!).messages).toContainEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "private reasoning",
          signature: "signed-reasoning",
        },
        {
          type: "tool_use",
          id: "call-1",
          name: "lookup",
          input: { query: "x" },
        },
      ],
    });
  });

  test("maps transcript and tool results to OpenAI Responses wire shape", () => {
    const request = JSON.parse(
      subscriptionRequest(
        "openai",
        { provider: "openai", model: "model-1", reasoningEffort: "high" },
        options,
      ),
    );
    expect(request).toMatchObject({
      model: "model-1",
      instructions: "Follow the rules.",
      stream: true,
      store: false,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    expect(request).not.toHaveProperty("prompt_cache_key");
    expect(request).not.toHaveProperty("cache_control");
    expect(JSON.stringify(request)).not.toContain("messageFingerprint");
    expect(JSON.stringify(request)).not.toContain("toolFingerprint");
    expect(request.input).toContainEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
    expect(
      request.input.some(
        (item: { type?: string; role?: string }) =>
          item.type === "message" && item.role === "assistant",
      ),
    ).toBe(false);
    expect(request.input).toContainEqual({
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: '{"query":"x"}',
    });
    const assistantRequest = JSON.parse(
      subscriptionRequest(
        "openai",
        { provider: "openai", model: "model-1", reasoningEffort: "high" },
        {
          systemPrompts: [],
          messages: [{ role: "assistant", content: "answer" }],
          tools: [],
        },
      ),
    );
    expect(assistantRequest.input).toContainEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    });
    expect(request.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "result",
    });
    expect(request.tools[0]).toMatchObject({
      type: "function",
      name: "lookup",
      parameters: { type: "object" },
    });
  });

  test("falls back once when Anthropic rejects the prompt-cache feature", async () => {
    const bodies: string[] = [];
    const client = {
      async *stream(body: string) {
        bodies.push(body);
        if (bodies.length === 1)
          throw new ProviderFeatureRejectedError("anthropic", "prompt-cache", 400);
        yield { type: "text" as const, text: "fallback worked" };
      },
    };
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "anthropic",
      model: "model-1",
      reasoningEffort: "medium",
    });
    const events = [];
    for await (const event of adapter.chatStream({ ...options, model: "model-1", logger }))
      events.push(event);

    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!).system[0]).toHaveProperty("cache_control");
    expect(JSON.parse(bodies[0]!).tools.at(-1)).toHaveProperty("cache_control");
    expect(JSON.parse(bodies[1]!).system).toBe("Follow the rules.");
    expect(JSON.parse(bodies[1]!).tools.at(-1)).not.toHaveProperty("cache_control");
    expect(
      events
        .flatMap((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : []))
        .join(""),
    ).toBe("fallback worked");
  });

  test("normalizes OpenAI history into valid alternating Anthropic turns", () => {
    const request = JSON.parse(
      subscriptionRequest(
        "anthropic",
        { provider: "anthropic", model: "claude-opus-5", reasoningEffort: "medium" },
        {
          messages: [
            { role: "user", content: "first" },
            { role: "user", content: "second" },
            {
              role: "assistant",
              content: null,
              thinking: [
                {
                  content: "provider-private",
                  signature: `openai-reasoning:${Buffer.from(
                    JSON.stringify({ id: "reasoning-1", encryptedContent: "secret" }),
                  ).toString("base64url")}`,
                },
              ],
            },
            {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  type: "function",
                  id: "call-1",
                  function: { name: "lookup", arguments: '{"key":"one"}' },
                },
                {
                  type: "function",
                  id: "call-2",
                  function: { name: "lookup", arguments: '{"key":"two"}' },
                },
              ],
            },
            { role: "tool", toolCallId: "call-1", content: "one" },
            { role: "tool", toolCallId: "call-2", content: "two" },
          ],
          systemPrompts: [],
          tools: [],
        },
        { promptCache: "disabled" },
      ),
    );

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "lookup", input: { key: "one" } },
          { type: "tool_use", id: "call-2", name: "lookup", input: { key: "two" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "one",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "call-2",
            content: "two",
            is_error: false,
          },
        ],
      },
    ]);
  });

  test("does not retry unrelated provider failures", async () => {
    let attempts = 0;
    const client = {
      async *stream() {
        attempts += 1;
        yield { type: "error" as const, code: "overloaded_error", message: "busy" };
      },
    };
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "anthropic",
      model: "model-1",
      reasoningEffort: "medium",
    });
    const stream = adapter
      .chatStream({ ...options, model: "model-1", logger })
      [Symbol.asyncIterator]();

    await stream.next();
    await expect(stream.next()).rejects.toThrow("anthropic overloaded_error: busy");
    expect(attempts).toBe(1);
  });

  test("accepts Anthropic content block end after streamed text", async () => {
    const client = {
      async *stream() {
        yield { type: "text" as const, text: "Which option?" };
        yield { type: "content-block-end" as const, index: 0 };
      },
    };
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "anthropic",
      model: "model-1",
      reasoningEffort: "medium",
    });
    const events = [];
    for await (const event of adapter.chatStream({
      ...options,
      model: "model-1",
      logger,
    }))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({ finishReason: "stop" });
  });

  test("forwards abort to the provider request and ends without a model error", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = {
      async *stream(_body: string, signal?: AbortSignal) {
        receivedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        yield { type: "text" as const, text: "unreachable" };
      },
    };
    const controller = new AbortController();
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "openai",
      model: "model-1",
      reasoningEffort: "high",
    });
    const stream = adapter
      .chatStream({
        ...options,
        model: "model-1",
        logger,
        abortController: controller,
      })
      [Symbol.asyncIterator]();

    expect((await stream.next()).value).toMatchObject({
      type: EventType.RUN_STARTED,
    });
    const pending = stream.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(receivedSignal).toBe(controller.signal);
  });

  test("forwards Anthropic abort and drops provider chunks emitted after cancellation", async () => {
    let receivedSignal: AbortSignal | undefined;
    let releaseProvider!: () => void;
    const providerReady = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const client = {
      async *stream(_body: string, signal?: AbortSignal) {
        receivedSignal = signal;
        yield { type: "text" as const, text: "before abort" };
        await providerReady;
        yield { type: "text" as const, text: "after abort" };
      },
    };
    const controller = new AbortController();
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "anthropic",
      model: "model-1",
      reasoningEffort: "medium",
    });
    const stream = adapter
      .chatStream({ ...options, model: "model-1", logger, abortController: controller })
      [Symbol.asyncIterator]();

    expect((await stream.next()).value).toMatchObject({ type: EventType.RUN_STARTED });
    expect((await stream.next()).value).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
    expect((await stream.next()).value).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "before abort",
    });
    expect(receivedSignal).toBe(controller.signal);
    const pending = stream.next();
    controller.abort();
    releaseProvider();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  test("emits streaming tool deltas and combined usage without provider secrets", async () => {
    const client = {
      async *stream() {
        yield { type: "usage" as const, promptTokens: 10, cachedPromptTokens: 4 };
        yield { type: "text" as const, text: "hello" };
        yield {
          type: "tool-call-start" as const,
          index: 1,
          id: "call-2",
          name: "nested",
        };
        yield {
          type: "tool-call-arguments" as const,
          index: 1,
          delta: '{"value":{"nested":true}}',
        };
        yield { type: "content-block-end" as const, index: 1 };
        yield { type: "usage" as const, completionTokens: 3 };
      },
    };
    const adapter = new SubscriptionTextAdapter(client, {
      provider: "anthropic",
      model: "model-1",
      reasoningEffort: "medium",
    });
    const events = [];
    for await (const event of adapter.chatStream({
      ...options,
      model: "model-1",
      logger,
    }))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({
      finishReason: "tool_calls",
      usage: {
        promptTokens: 10,
        completionTokens: 3,
        totalTokens: 13,
        promptTokensDetails: { cachedTokens: 4 },
      },
    });
    expect(JSON.stringify(events)).not.toContain("Authorization");
  });

  test("maps transcript and tool results to Anthropic Messages wire shape", () => {
    const request = JSON.parse(
      subscriptionRequest(
        "anthropic",
        { provider: "anthropic", model: "model-1", reasoningEffort: "medium" },
        options,
      ),
    );
    expect(request).toMatchObject({
      model: "model-1",
      system: [
        {
          type: "text",
          text: "Follow the rules.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      stream: true,
      output_config: { effort: "medium" },
    });
    expect(request.tools.at(-1)).toMatchObject({
      name: "lookup",
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(providerProtocols.anthropic.modelHeaders["anthropic-beta"]).toContain(
      "prompt-caching-scope-2026-01-05",
    );
    expect(request.messages).toContainEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning text",
          signature: "signed",
        },
        {
          type: "tool_use",
          id: "call-1",
          name: "lookup",
          input: { query: "x" },
        },
      ],
    });
    expect(request.messages).toContainEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "result",
          is_error: false,
        },
      ],
    });
  });
});
