import { Context, Effect, Option } from "effect";
import { expect, test } from "vite-plus/test";
import { makeAgentChatImplementation } from "../src/agent/chat.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { sqliteChatPersistence } from "../src/chat-state/persistence.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { ProviderUnavailable } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { testRuntime } from "./support/runtime.ts";

const request = () =>
  new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-ui",
      runId: crypto.randomUUID(),
      messages: [{ id: "m1", role: "user", content: "hello" }],
      tools: [],
      context: [],
    }),
  });

test("native factory reacquires central dependencies per construction and per adapter", async () => {
  const { runtime, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  await runtime.runPromise(
    Effect.flatMap(GlobalConfig, (config) =>
      config.update({ provider: "openai", model: "missing-model", reasoningEffort: "low" }),
    ),
  );
  const registry = await runtime.runPromise(ProviderRegistry);
  const acquired: number[] = [];
  const released: number[] = [];
  for (const owner of [1, 2]) {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* makeAgentChatImplementation();
          for (let turn = 0; turn < 2; turn++) {
            const response = yield* chat.handle(request(), session.id);
            expect(response.status).toBe(409);
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              error: "model_unavailable_for_account",
            });
          }
        }).pipe(
          Effect.provideService(ProviderRegistry, {
            ...registry,
            subscriptionDependencies: () =>
              Effect.sync(() => {
                acquired.push(owner);
                return {
                  client: () => ({
                    releaseRun: () => released.push(owner),
                    stream: async function* () {
                      yield* [];
                      throw new Error("model check must precede streaming");
                    },
                  }),
                };
              }),
          }),
        ),
      ),
    );
  }
  expect(acquired).toEqual([1, 1, 2, 2]);
  expect(released).toEqual([1, 1, 2, 2]);
  expect(provider!.adapter.invocations).toHaveLength(0);
});

test("two fresh native constructions stream and persist successful turns without legacy adapters", async () => {
  const { runtime, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  const registry = await runtime.runPromise(ProviderRegistry);
  const nodes = await runtime.runPromise(Nodes);
  const { sqlite } = await runtime.runPromise(Database);
  const persistence = sqliteChatPersistence(sqlite);
  const acquired: number[] = [];
  const released: number[] = [];
  const streamed: number[] = [];
  for (const owner of [1, 2]) {
    const answer = `native-owner-${owner}`;
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* makeAgentChatImplementation();
          expect(acquired).toHaveLength(owner - 1);
          const response = yield* chat.handle(request(), session.id);
          expect(response.status).toBe(200);
          expect(response.headers.get("Content-Type")).toContain("text/event-stream");
          const text = yield* Effect.promise(() => response.text());
          expect(text).toContain(answer);
          expect(text).toContain("RUN_FINISHED");
          expect(released).toEqual(Array.from({ length: owner }, (_, index) => index + 1));
          expect(
            nodes
              .session(session.id)
              .filter((node) => node.kind === "assistant")
              .map((node) => node.text),
          ).toContain(answer);
          const messages = yield* Effect.promise(() =>
            persistence.stores.messages.loadThread(session.id),
          );
          expect(
            messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.content),
          ).toContain(answer);
        }).pipe(
          Effect.provideService(ProviderRegistry, {
            ...registry,
            subscriptionDependencies: () =>
              Effect.sync(() => {
                acquired.push(owner);
                return {
                  client: () => ({
                    releaseRun: () => released.push(owner),
                    stream: async function* (): AsyncGenerator<NormalizedStreamEvent> {
                      streamed.push(owner);
                      yield { type: "text", text: answer };
                      yield { type: "usage", promptTokens: 10, completionTokens: 5 };
                    },
                  }),
                };
              }),
          }),
        ),
      ),
    );
  }
  expect(acquired).toEqual([1, 2]);
  expect(streamed).toEqual([1, 2]);
  expect(released).toEqual([1, 2]);
  expect(provider!.adapter.invocations).toHaveLength(0);
});

test("custom ActiveProvider context works without a ProviderRegistry service", async () => {
  const { runtime, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  const services = await runtime.runPromise(Effect.context());
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        expect(Option.isNone(yield* Effect.serviceOption(ProviderRegistry))).toBe(true);
        const chat = yield* makeAgentChatImplementation();
        const response = yield* chat.handle(request(), session.id);
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.text());
      }),
    ).pipe(Effect.provideContext(Context.omit(ProviderRegistry)(services))),
  );
  expect(provider!.adapter.invocations.length).toBeGreaterThan(0);
});

test("a present dependency method failure never falls back to a custom runtime", async () => {
  const { runtime, session, provider } = await testRuntime({ testProvider: {} });
  await provider!.select(runtime);
  const registry = await runtime.runPromise(ProviderRegistry);
  const response = await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* makeAgentChatImplementation();
        return yield* chat.handle(request(), session.id);
      }).pipe(
        Effect.provideService(ProviderRegistry, {
          ...registry,
          subscriptionDependencies: (provider) =>
            Effect.fail(new ProviderUnavailable({ provider })),
        }),
      ),
    ),
  );
  expect(response.status).toBe(503);
  expect(provider!.adapter.invocations).toHaveLength(0);
});
