import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
// Native SDK generators preserve their wire contract while each owner is scoped by Effect.
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../src/agent/chat.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { sqliteChatPersistence } from "../src/chat-state/persistence.ts";
import type { NormalizedStreamEvent } from "../src/oauth/protocol.ts";
import { ProviderUnavailable } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { testRuntime } from "./support/runtime.ts";

const request = Effect.fn("NativeFactoryTest.request")(function* () {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      threadId: "thread-ui",
      runId: yield* (yield* Crypto.Crypto).randomUUIDv4(),
      messages: [{ id: "m1", role: "user", content: "hello" }],
      tools: [],
      context: [],
    }),
  });
});

it.live("native factory reacquires central dependencies per construction and per adapter", () =>
  withCrypto(
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* sdkCall(() =>
        testRuntime({ testProvider: {} }),
      );
      yield* sdkCall(() => provider!.select(runtime));
      yield* Effect.provideContext(
        Effect.flatMap(GlobalConfig, (config) =>
          config.update({ provider: "openai", model: "missing-model", reasoningEffort: "low" }),
        ),
        yield* runtime.contextEffect,
      );
      const registry = yield* Effect.provideContext(ProviderRegistry, yield* runtime.contextEffect);
      const acquired: number[] = [];
      const released: number[] = [];
      for (const owner of [1, 2]) {
        yield* Effect.provideContext(
          Effect.scoped(
            Effect.gen(function* () {
              const chat = yield* makeAgentChatImplementation();
              for (let turn = 0; turn < 2; turn++) {
                const response = yield* chat.handle(yield* request(), session.id);
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
                        stream: function () {
                          return nativeStream(
                            Stream.suspend(() =>
                              Stream.fail(
                                new Cause.UnknownError(
                                  new Error("model check must precede streaming"),
                                ),
                              ),
                            ),
                          );
                        },
                      }),
                    };
                  }),
              }),
            ),
          ),
          yield* runtime.contextEffect,
        );
      }
      expect(acquired).toEqual([1, 1, 2, 2]);
      expect(released).toEqual([1, 1, 2, 2]);
      expect(provider!.adapter.invocations).toHaveLength(0);
    }),
  ),
);

it.live(
  "two fresh native constructions stream and persist successful turns without legacy adapters",
  () =>
    withCrypto(
      Effect.gen(function* () {
        const { runtime, session, provider } = yield* sdkCall(() =>
          testRuntime({ testProvider: {} }),
        );
        yield* sdkCall(() => provider!.select(runtime));
        const registry = yield* Effect.provideContext(
          ProviderRegistry,
          yield* runtime.contextEffect,
        );
        const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
        const { sqlite } = yield* Effect.provideContext(Database, yield* runtime.contextEffect);
        const persistence = sqliteChatPersistence(sqlite);
        const acquired: number[] = [];
        const released: number[] = [];
        const streamed: number[] = [];
        for (const owner of [1, 2]) {
          const answer = `native-owner-${owner}`;
          yield* Effect.provideContext(
            Effect.scoped(
              Effect.gen(function* () {
                const chat = yield* makeAgentChatImplementation();
                expect(acquired).toHaveLength(owner - 1);
                const response = yield* chat.handle(yield* request(), session.id);
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
                          stream: function (): AsyncGenerator<NormalizedStreamEvent> {
                            return nativeStream(
                              Stream.suspend(() =>
                                Stream.fromIterable(
                                  (function* (): Generator<NormalizedStreamEvent> {
                                    streamed.push(owner);
                                    yield { type: "text", text: answer };
                                    yield { type: "usage", promptTokens: 10, completionTokens: 5 };
                                  })(),
                                ),
                              ),
                            );
                          },
                        }),
                      };
                    }),
                }),
              ),
            ),
            yield* runtime.contextEffect,
          );
        }
        expect(acquired).toEqual([1, 2]);
        expect(streamed).toEqual([1, 2]);
        expect(released).toEqual([1, 2]);
        expect(provider!.adapter.invocations).toHaveLength(0);
      }),
    ),
);

it.live("custom ActiveProvider context works without a ProviderRegistry service", () =>
  withCrypto(
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* sdkCall(() =>
        testRuntime({ testProvider: {} }),
      );
      yield* sdkCall(() => provider!.select(runtime));
      const services = yield* runtime.contextEffect;
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(Option.isNone(yield* Effect.serviceOption(ProviderRegistry))).toBe(true);
          const chat = yield* makeAgentChatImplementation();
          const response = yield* chat.handle(yield* request(), session.id);
          expect(response.status).toBe(200);
          yield* Effect.promise(() => response.text());
        }),
      ).pipe(Effect.provideContext(Context.omit(ProviderRegistry)(services)));
      expect(provider!.adapter.invocations.length).toBeGreaterThan(0);
    }),
  ),
);

it.live("a present dependency method failure never falls back to a custom runtime", () =>
  withCrypto(
    Effect.gen(function* () {
      const { runtime, session, provider } = yield* sdkCall(() =>
        testRuntime({ testProvider: {} }),
      );
      yield* sdkCall(() => provider!.select(runtime));
      const registry = yield* Effect.provideContext(ProviderRegistry, yield* runtime.contextEffect);
      const response = yield* Effect.provideContext(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* makeAgentChatImplementation();
            return yield* chat.handle(yield* request(), session.id);
          }).pipe(
            Effect.provideService(ProviderRegistry, {
              ...registry,
              subscriptionDependencies: (provider) =>
                Effect.fail(new ProviderUnavailable({ provider })),
            }),
          ),
        ),
        yield* runtime.contextEffect,
      );
      expect(response.status).toBe(503);
      expect(provider!.adapter.invocations).toHaveLength(0);
    }),
  ),
);

const sdkCall = Effect.fn("NativeFactoryTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
const withCrypto = Effect.fn("NativeFactoryTest.crypto")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.build(NodeCrypto.layer);
  return yield* Effect.provideContext(program, context);
});
