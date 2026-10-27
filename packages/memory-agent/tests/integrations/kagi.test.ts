import { layer } from "@effect/vitest";
import { Context, Effect, Layer, Ref, Result, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../../src/json.ts";
import { Kagi, KagiKeyMissing } from "../../src/kagi/kagi.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { KagiTools, maxPageCharacters } from "../../src/tools/kagi.ts";
import { runTurn, wireOf } from "../support/chat-client.ts";
import { HttpServerRequest, HttpServerResponse, testHttpServer } from "../support/http.ts";
import { selectTestModel } from "../support/provider.ts";
import { callTool } from "../support/run-tools.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: JsonValue;
}

interface Reply {
  readonly status: number;
  readonly body: JsonValue;
}

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

/** The call fails, and the failure the model reads names `reason`. */
const rejects = Effect.fnUntraced(function* <A, E>(call: Effect.Effect<A, E>, reason: string) {
  expect(yield* Effect.flip(call)).toMatchObject({ message: expect.stringContaining(reason) });
});

const tools = Effect.flatMap(KagiTools, (kagiTools) => kagiTools.runTools);

/** Calls of the tool as Kagi was when they were handed out. */
const toolNamed = Effect.fnUntraced(function* (name: "kagi_search" | "kagi_extract") {
  const handedOut = yield* tools;
  return (params: JsonValue) => callTool(handedOut, name, params);
});

const enable = Effect.gen(function* () {
  const kagi = yield* Kagi;
  yield* kagi.registerKey("sk-test-key");
  return yield* kagi.setEnabled(true);
});

testAgent()("Kagi settings", (it) => {
  it.effect(
    "stays off until a key is registered and Kagi is turned on; removing the key turns it off",
    () =>
      Effect.gen(function* () {
        const kagi = yield* Kagi;
        expect(yield* kagi.status).toEqual({ keyRegistered: false, enabled: false });
        const refused = yield* Effect.result(kagi.setEnabled(true));
        expect(Result.isFailure(refused) && refused.failure).toBeInstanceOf(KagiKeyMissing);
        yield* kagi.registerKey("  sk-test-key  ");
        expect(yield* kagi.status).toEqual({ keyRegistered: true, enabled: false });
        expect(yield* tools).toEqual([]);
        expect(yield* kagi.setEnabled(true)).toEqual({ keyRegistered: true, enabled: true });
        expect((yield* tools).map(({ tool }) => tool.name)).toEqual([
          "kagi_search",
          "kagi_extract",
        ]);
        yield* kagi.removeKey;
        expect(yield* kagi.status).toEqual({ keyRegistered: false, enabled: false });
        expect(yield* tools).toEqual([]);
      }),
  );
});

/** A Kagi API on a local port: it records each request and answers with the current reply. */
class FakeKagi extends Context.Service<
  FakeKagi,
  {
    readonly reply: Ref.Ref<(path: string) => Reply>;
    readonly received: Ref.Ref<ReadonlyArray<Received>>;
  }
>()("memory-agent/tests/integrations/kagi.test/FakeKagi") {}

/** The agent talks to the fake API, which outlives it in the block's Scope. */
const kagiAgent = Layer.unwrap(
  Effect.gen(function* () {
    const reply = yield* Ref.make((_path: string) => searchReply);
    const received = yield* Ref.make<ReadonlyArray<Received>>([]);
    const { url } = yield* testHttpServer(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* HttpServerRequest.schemaBodyJson(Schema.Json);
        const path = request.url;
        yield* Ref.update(received, (all) => [
          ...all,
          { path, authorization: request.headers.authorization, body },
        ]);
        const { status, body: answer } = (yield* Ref.get(reply))(path);
        return yield* HttpServerResponse.json(answer, { status });
      }),
    );
    return TestEnv.layer({ testProvider: {}, kagiBaseUrl: `${url}/api/v1` }).pipe(
      Layer.merge(Layer.succeed(FakeKagi, FakeKagi.of({ reply, received }))),
    );
  }),
);

/** Answer every request with `reply` from now on, with no requests recorded yet. */
const serve = Effect.fnUntraced(function* (reply: (path: string) => Reply = () => searchReply) {
  const fake = yield* FakeKagi;
  yield* Ref.set(fake.reply, reply);
  yield* Ref.set(fake.received, []);
  return { received: Ref.get(fake.received) };
});

layer(kagiAgent, { excludeTestServices: true })("Kagi tools", (it) => {
  it.effect(
    "search sends the SDK request with the stored key and marks snippets as summaries",
    () =>
      Effect.gen(function* () {
        const { received } = yield* serve();
        yield* enable;
        const search = yield* toolNamed("kagi_search");
        const result = yield* search({ query: "effect schema", limit: 50 });
        expect(yield* received).toEqual([
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

  it.effect("extract keeps page failures, missing pages and cut Markdown apart", () =>
    Effect.gen(function* () {
      const long = "x".repeat(maxPageCharacters + 10);
      const { received } = yield* serve(() => ({
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
      yield* enable;
      const extract = yield* toolNamed("kagi_extract");
      const urls = [
        "https://example.com/ok",
        "https://example.com/long",
        "https://example.com/broken",
        "https://example.com/dropped",
      ];
      const result = yield* extract({ urls });
      expect((yield* received)[0]?.body).toEqual({
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
      yield* rejects(extract({ urls: ["file:///etc/hosts"] }), "invalid_urls");
      expect(yield* received).toHaveLength(1);
    }),
  );

  it.effect("errors carry their HTTP reason and are not retried", () =>
    Effect.gen(function* () {
      const replies: ReadonlyArray<{ readonly reply: Reply; readonly reason: string }> = [
        { reply: { status: 401, body: { error: [] } }, reason: "kagi_unauthorized" },
        { reply: { status: 429, body: { error: [] } }, reason: "kagi_rate_limited" },
        // A 200 that does not match the SDK schema is not passed off as results.
        {
          reply: { status: 200, body: { data: { search: "nope" } } },
          reason: "kagi_invalid_response",
        },
      ];
      const fake = yield* FakeKagi;
      const { received } = yield* serve();
      yield* enable;
      const search = yield* toolNamed("kagi_search");
      for (const { reply, reason } of replies) {
        yield* Ref.set(fake.reply, () => reply);
        yield* rejects(search({ query: reason }), reason);
      }
      expect(yield* received).toHaveLength(replies.length);
    }),
  );

  it.effect(
    "a key removed after the tools were handed out stops the next call before any request",
    () =>
      Effect.gen(function* () {
        const { received } = yield* serve();
        yield* enable;
        const search = yield* toolNamed("kagi_search");
        yield* (yield* Kagi).removeKey;
        yield* rejects(search({ query: "after removal" }), "kagi_not_enabled");
        expect(yield* received).toEqual([]);
      }),
  );

  it.effect("a chat run offers the tools and their instructions only while Kagi is on", () =>
    Effect.gen(function* () {
      const { project, provider } = yield* TestEnv;
      yield* serve();
      yield* (yield* Kagi).removeKey;
      yield* selectTestModel();
      const session = (yield* (yield* Sessions).create(project.id)).id;
      const send = Effect.fnUntraced(function* (runId: string, text: string) {
        const invocationIndex = provider?.invocations.length ?? 0;
        const events = yield* wireOf(yield* runTurn(session, runId, text));
        return { events, invocation: provider?.invocations[invocationIndex] };
      });
      const off = yield* send(`${session}:off`, "hello");
      expect(off.invocation?.toolNames).not.toContain("kagi_search");
      expect(off.invocation?.system.join("\n")).not.toContain("Kagi web search is enabled");
      yield* enable;
      const on = yield* send(`${session}:on`, 'call kagi_search {"query":"effect schema"}');
      expect(on.invocation?.toolNames).toContain("kagi_search");
      expect(on.invocation?.system.join("\n")).toContain("Kagi web search is enabled");
      expect(on.events).toContain("summary of A");
      expect(on.events).not.toContain("sk-test-key");
    }),
  );
});
