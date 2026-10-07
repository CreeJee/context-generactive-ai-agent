import { it } from "@effect/vitest";
import type { JsonValue } from "../src/json.ts";
import { selectTestModel } from "./support/provider.ts";
import { isTruthy } from "../src/truthy.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AnyServerTool } from "@tanstack/ai";
import { Cause, Effect, Fiber, Random, Result, Schema, Scope, Stream } from "effect";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Kagi } from "../src/kagi/kagi.ts";
import { KagiTools, maxPageCharacters } from "../src/tools/kagi.ts";
import { testRuntime } from "./support/runtime.ts";

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: JsonValue;
}

type Reply = { readonly status: number; readonly body: JsonValue };

const sdkCall = Effect.fn("kagiTest.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const rejects = Effect.fn("kagiTest.rejects")(function* <A>(
  operation: () => PromiseLike<A>,
  message: string,
) {
  const result = yield* Effect.result(sdkCall(operation));
  Result.match(result, {
    onSuccess: () => {
      throw new Error("Expected SDK failure");
    },
    onFailure: (error) =>
      expect(() => {
        throw error.cause;
      }).toThrow(message),
  });
});
const readBody = Effect.fn("kagiTest.readBody")(function* (request: IncomingMessage) {
  const chunks = yield* Stream.runCollect(
    Stream.fromAsyncIterable(request, (cause) => new Cause.UnknownError(cause)),
  );
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
  );
});
// The SDK fixture speaks real HTTP; its listener and request Fibers belong to the test Scope.
const fakeKagi = Effect.fn("kagiTest.fakeKagi")(function* (reply: (path: string) => Reply) {
  const received: Received[] = [];
  const context = yield* Effect.context<never>();
  const scope = yield* Scope.Scope;
  const handle = Effect.fn("kagiTest.handle")(function* (
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const path = request.url ?? "";
    received.push({
      path,
      authorization: request.headers.authorization,
      body: yield* readBody(request),
    });
    const { status, body } = reply(path);
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(body);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(json);
  });
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        void Effect.runPromiseWith(context)(
          handle(request, response).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
        ).catch((cause) =>
          response.destroy(
            cause instanceof Error ? cause : new Error("Fixture request failed", { cause }),
          ),
        );
      }),
    ),
    (server) =>
      server.listening
        ? Effect.callback<void, Cause.UnknownError>((resume) => {
            server.close((error) =>
              resume(
                error === undefined ? Effect.void : Effect.fail(new Cause.UnknownError(error)),
              ),
            );
            server.closeAllConnections();
          }).pipe(Effect.orDie)
        : Effect.void,
  );
  yield* Effect.callback<void, Cause.UnknownError>((resume) => {
    const fail = (error: Error) => resume(Effect.fail(new Cause.UnknownError(error)));
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.off("error", fail);
    });
  });
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
    server.address(),
  );
  return { baseUrl: "http://127.0.0.1:" + address.port + "/api/v1", received };
});

const searchReply: Reply = {
  status: 200,
  body: {
    meta: { trace: "t1" },
    data: {
      search: [{ url: "https://example.com/a", title: "A", snippet: "summary of A" }],
      relatedSearch: [{ url: "https://kagi.com/search?q=b", title: "B" }],
    },
  },
};

const kagiSetup = Effect.fn("kagiTest.setup")(function* (
  reply: (path: string) => Reply = () => searchReply,
) {
  const kagi = yield* fakeKagi(reply);
  const context = yield* sdkCall(() =>
    testRuntime({ testProvider: {}, kagiBaseUrl: kagi.baseUrl }),
  );
  const enable = Effect.fn("kagiTest.enable")(function* () {
    return yield* Effect.provideContext(
      Effect.gen(function* () {
        const service = yield* Kagi;
        yield* service.registerKey("sk-test-key");
        return yield* service.setEnabled(true);
      }),
      yield* context.runtime.contextEffect,
    );
  });
  const tools = Effect.fn("kagiTest.tools")(function* () {
    return yield* Effect.provideContext(
      Effect.flatMap(KagiTools, (tools) => tools.tools),
      yield* context.runtime.contextEffect,
    );
  });
  return { ...context, kagi, enable, tools };
});

function toolNamed(tools: readonly AnyServerTool[], name: string) {
  const execute = tools.find((candidate) => candidate.name === name)?.execute;
  if (!isTruthy(execute)) throw new Error(`no ${name}`);
  return execute;
}

describe("Kagi settings", () => {
  it.live(
    "stays off until a key is registered and Kagi is turned on; removing the key turns it off",
    () =>
      Effect.gen(function* () {
        const { runtime, tools } = yield* kagiSetup();
        const kagi = yield* Effect.provideContext(Kagi, yield* runtime.contextEffect);
        expect(yield* Effect.provideContext(kagi.status, yield* runtime.contextEffect)).toEqual({
          keyRegistered: false,
          enabled: false,
        });
        const refused = yield* Effect.provideContext(
          Effect.result(kagi.setEnabled(true)),
          yield* runtime.contextEffect,
        );
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("KagiKeyMissing");
        yield* Effect.provideContext(
          kagi.registerKey("  sk-test-key  "),
          yield* runtime.contextEffect,
        );
        expect(yield* Effect.provideContext(kagi.status, yield* runtime.contextEffect)).toEqual({
          keyRegistered: true,
          enabled: false,
        });
        expect(yield* tools()).toEqual([]);
        expect(
          yield* Effect.provideContext(kagi.setEnabled(true), yield* runtime.contextEffect),
        ).toEqual({
          keyRegistered: true,
          enabled: true,
        });
        expect((yield* tools()).map((candidate) => candidate.name)).toEqual([
          "kagi_search",
          "kagi_extract",
        ]);
        yield* Effect.provideContext(kagi.removeKey, yield* runtime.contextEffect);
        expect(yield* Effect.provideContext(kagi.status, yield* runtime.contextEffect)).toEqual({
          keyRegistered: false,
          enabled: false,
        });
        expect(yield* tools()).toEqual([]);
      }),
  );
});

describe("Kagi tools", () => {
  it.live("search sends the SDK request with the stored key and marks snippets as summaries", () =>
    Effect.gen(function* () {
      const { enable, tools, kagi } = yield* kagiSetup();
      yield* enable();
      const search = toolNamed(yield* tools(), "kagi_search");
      const result = yield* sdkCall(() => search({ query: "effect schema", limit: 50 }));
      expect(kagi.received).toEqual([
        {
          path: "/api/v1/search",
          authorization: "Bearer sk-test-key",
          body: { query: "effect schema", limit: 20 },
        },
      ]);
      expect(result).toMatchObject({
        results: [{ url: "https://example.com/a", title: "A", snippet: "summary of A" }],
        note: expect.stringContaining("not verbatim"),
      });
    }),
  );

  it.live("extract keeps page failures, missing pages and cut Markdown apart", () =>
    Effect.gen(function* () {
      const long = "x".repeat(maxPageCharacters + 10);
      const { enable, tools, kagi } = yield* kagiSetup(() => ({
        status: 200,
        body: {
          meta: {},
          data: [
            { url: "https://example.com/ok", markdown: "# OK" },
            { url: "https://example.com/long", markdown: long },
            { url: "https://example.com/broken", markdown: null, error: "fetch failed" },
          ],
          errors: [{ code: "timeout", url: "https://example.com/broken", message: "timed out" }],
        },
      }));
      yield* enable();
      const extract = toolNamed(yield* tools(), "kagi_extract");
      const urls = [
        "https://example.com/ok",
        "https://example.com/long",
        "https://example.com/broken",
        "https://example.com/dropped",
      ];
      const result = yield* sdkCall(() => extract({ urls }));
      expect(kagi.received[0]?.body).toEqual({
        pages: urls.map((url) => ({ url })),
        format: "markdown",
      });
      expect(result).toMatchObject({
        requested: 4,
        succeeded: 2,
        pages: [
          { url: "https://example.com/ok", status: "ok", markdown: "# OK", truncated: false },
          { url: "https://example.com/long", status: "ok", truncated: true },
          { url: "https://example.com/broken", status: "failed", error: "fetch failed" },
        ],
        errors: [
          { url: "https://example.com/broken", code: "timeout", message: "timed out" },
          { url: "https://example.com/dropped", code: "missing", message: null },
        ],
      });
      yield* rejects(() => extract({ urls: ["file:///etc/hosts"] }), "invalid_urls");
      expect(kagi.received).toHaveLength(1);
    }),
  );

  it.live("errors carry their HTTP reason and are not retried", () =>
    Effect.gen(function* () {
      let reply: Reply = { status: 401, body: { error: [] } };
      const { enable, tools, kagi } = yield* kagiSetup(() => reply);
      yield* enable();
      const search = toolNamed(yield* tools(), "kagi_search");
      yield* rejects(() => search({ query: "a" }), "kagi_unauthorized");
      reply = { status: 429, body: { error: [] } };
      yield* rejects(() => search({ query: "b" }), "kagi_rate_limited");
      // A 200 that does not match the SDK schema is not passed off as results.
      reply = { status: 200, body: { data: { search: "nope" } } };
      yield* rejects(() => search({ query: "c" }), "kagi_invalid_response");
      expect(kagi.received).toHaveLength(3);
    }),
  );

  it.live(
    "a key removed after the tools were handed out stops the next call before any request",
    () =>
      Effect.gen(function* () {
        const { runtime, enable, tools, kagi } = yield* kagiSetup();
        yield* enable();
        const search = toolNamed(yield* tools(), "kagi_search");
        yield* Effect.provideContext(
          Effect.flatMap(Kagi, (service) => service.removeKey),
          yield* runtime.contextEffect,
        );
        yield* rejects(() => search({ query: "after removal" }), "kagi_not_enabled");
        expect(kagi.received).toEqual([]);
      }),
  );

  it.live("a chat run offers the tools and their instructions only while Kagi is on", () =>
    Effect.gen(function* () {
      const context = yield* kagiSetup();
      const { runtime, session, enable } = context;
      yield* Effect.provideContext(selectTestModel(), yield* runtime.contextEffect);
      const send = Effect.fn("kagiTest.send")(function* (text: string) {
        const invocationIndex = context.provider!.adapter.invocations.length;
        const response = yield* Effect.provideContext(
          Effect.flatMap(
            AgentChat,
            Effect.fnUntraced(function* (agent) {
              return yield* agent.handle(
                new Request("http://127.0.0.1/api/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    threadId: session.id,
                    runId: `run-${(yield* Random.next).toString(36).slice(2)}`,
                    messages: [{ id: "m1", role: "user", content: text }],
                    tools: [],
                    context: [],
                  }),
                }),
                session.id,
              );
            }),
          ),
          yield* runtime.contextEffect,
        );
        const events = yield* sdkCall(() => response.text());
        const invocation = context.provider!.adapter.invocations[invocationIndex];
        return { events, invocation };
      });
      const off = yield* send("hello");
      expect(off.invocation?.toolNames).not.toContain("kagi_search");
      expect(off.invocation?.systemPrompts.join("\n")).not.toContain("Kagi web search is enabled");
      yield* enable();
      const on = yield* send('call kagi_search {"query":"effect schema"}');
      expect(on.invocation?.toolNames).toContain("kagi_search");
      expect(on.invocation?.systemPrompts.join("\n")).toContain("Kagi web search is enabled");
      expect(on.events).toContain("summary of A");
      expect(on.events).not.toContain("sk-test-key");
    }),
  );
});
