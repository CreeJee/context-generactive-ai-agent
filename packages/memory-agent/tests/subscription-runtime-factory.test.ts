import { Cause } from "effect";
import { it } from "@effect/vitest";
import { MutableHashMap, DateTime, Effect, Stream } from "effect";
import { EventType, type TextOptions } from "@tanstack/ai";
import { InternalLogger } from "@tanstack/ai/adapter-internals";
import { expect } from "vite-plus/test";
import { sdkCancellation } from "./support/sdk-cancellation.ts";
import { createSubscriptionOAuthClient } from "../src/oauth/subscription-oauth.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import { SubscriptionTextAdapter } from "../src/providers/subscription-adapter.ts";
import { createSubscriptionRuntimeImplementation } from "../src/providers/subscription-runtime.ts";

const logger = new InternalLogger(
  { debug() {}, info() {}, warn() {}, error() {} },
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

const selection = { provider: "openai", model: "gpt-5", reasoningEffort: "low" } as const;

it.effect("retained native implementation binds fresh central clients and pins each run", () =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context());
    const implementation = createSubscriptionRuntimeImplementation("openai");
    const routes = MutableHashMap.empty<string, string>();
    const requests: {
      auth: string | null;
      body: string;
      signal: AbortSignal | null | undefined;
    }[] = [];
    const released: string[] = [];
    let credentialReads = 0;
    const nativeClient = (account: string) =>
      createSubscriptionOAuthClient({
        protocol: providerProtocols.openai,
        store: {
          read() {
            credentialReads++;
            return Promise.resolve({
              accessToken: account,
              refreshToken: "controlled-refresh",
              accountId: account,
              expiresAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
            });
          },
          write() {
            return Promise.reject(new Error("unexpected credential refresh"));
          },
          remove() {
            return Promise.reject(new Error("unexpected credential removal"));
          },
        },
        fetch: (_url, init) =>
          run(
            Effect.gen(function* () {
              requests.push({
                auth: new Headers(init?.headers).get("authorization"),
                body: yield* Effect.promise(() => new Response(init?.body).text()),
                signal: init?.signal,
              });
              return new Response(
                'data: {"type":"response.output_text.delta","delta":"native reply"}\n\ndata: {"type":"response.completed"}\n\n',
                {
                  headers: { "content-type": "text/event-stream" },
                },
              );
            }),
          ),
      });
    const centralClients = { first: nativeClient("first"), second: nativeClient("second") };
    let selected: keyof typeof centralClients = "first";
    let acquisitions = 0;
    const firstRuntime = implementation.bind({
      client: () => {
        const account = selected;
        const id = `run-${++acquisitions}`;
        MutableHashMap.set(routes, id, account);
        return {
          stream: centralClients[account].stream.bind(centralClients[account]),
          releaseRun: () => {
            MutableHashMap.remove(routes, id);
            released.push(id);
          },
        };
      },
      catalogWindow: () => 111,
    });
    const firstAdapter = firstRuntime.adapter(selection);
    selected = "second";
    const secondRuntime = implementation.bind({
      client: () => {
        acquisitions++;
        MutableHashMap.set(routes, "fresh-run", "second");
        return {
          stream: centralClients.second.stream.bind(centralClients.second),
          releaseRun: () => {
            MutableHashMap.remove(routes, "fresh-run");
            released.push("fresh-run");
          },
        };
      },
      catalogWindow: () => 222,
    });
    const secondAdapter = secondRuntime.adapter({ ...selection, reasoningEffort: "high" });
    expect(firstAdapter).toBeInstanceOf(SubscriptionTextAdapter);
    expect(secondAdapter).toBeInstanceOf(SubscriptionTextAdapter);
    expect(firstRuntime.contextWindow(selection.model)).toBe(111);
    expect(secondRuntime.contextWindow(selection.model)).toBe(222);
    const controllers = [(yield* sdkCancellation).controller, (yield* sdkCancellation).controller];
    for (const [index, adapter] of [firstAdapter, secondAdapter].entries()) {
      const options: TextOptions<Record<string, never>> = {
        messages: [{ role: "user", content: `fresh-${index}` }],
        model: selection.model,
        logger,
        abortController: controllers[index],
        runId: `sdk-run-${index}`,
        threadId: `thread-${index}`,
      };
      const chunks = yield* Stream.runCollect(
        Stream.fromAsyncIterable(
          adapter.chatStream(options),
          (cause) => new Cause.UnknownError(cause),
        ),
      );
      expect(
        chunks.some(
          (chunk) => chunk.type === EventType.RUN_FINISHED && chunk.runId === `sdk-run-${index}`,
        ),
      ).toBe(true);
    }
    expect(requests.map((request) => request.auth)).toEqual(["Bearer first", "Bearer second"]);
    expect(requests[0]?.body).toContain("fresh-0");
    expect(requests[1]?.body).toContain("fresh-1");
    expect(requests[0]?.signal).toBe(controllers[0]?.signal);
    expect(requests[1]?.signal).toBe(controllers[1]?.signal);
    expect(credentialReads).toBe(2);
    expect(acquisitions).toBe(2);
    expect(MutableHashMap.size(routes)).toBe(2);
    firstAdapter.releaseRun?.();
    expect([...routes]).toEqual([["fresh-run", "second"]]);
    secondAdapter.releaseRun?.();
    expect(MutableHashMap.size(routes)).toBe(0);
    expect(released).toEqual(["run-1", "fresh-run"]);
    expect(firstRuntime.runMiddleware()).toEqual(secondRuntime.runMiddleware());
    expect(firstRuntime.runMiddleware()).not.toBe(secondRuntime.runMiddleware());
    expect(() => secondRuntime.adapter({ ...selection, provider: "anthropic" })).toThrow(
      "Provider mismatch",
    );
    expect(acquisitions).toBe(2);
  }),
);
