import { createServer, type IncomingMessage } from "node:http";
import type { AnyServerTool } from "@tanstack/ai";
import type { AddressInfo } from "node:net";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Kagi } from "../src/kagi/kagi.ts";
import { KagiTools, maxPageCharacters } from "../src/tools/kagi.ts";
import { testRuntime } from "./support/runtime.ts";

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

type Reply = { readonly status: number; readonly body: unknown };

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A local stand-in for kagi.com/api/v1 that records requests and answers with `reply`. */
async function fakeKagi(reply: (path: string) => Reply) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    received.push({
      path,
      authorization: request.headers.authorization,
      body: await readBody(request),
    });
    const { status, body } = reply(path);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/api/v1`, received };
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

async function kagiSetup(reply: (path: string) => Reply = () => searchReply) {
  const kagi = await fakeKagi(reply);
  const context = await testRuntime({ testProvider: {}, kagiBaseUrl: kagi.baseUrl });
  const enable = () =>
    context.runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* Kagi;
        yield* service.registerKey("sk-test-key");
        return yield* service.setEnabled(true);
      }),
    );
  const tools = () => context.runtime.runPromise(Effect.flatMap(KagiTools, (tools) => tools.tools));
  return { ...context, kagi, enable, tools };
}

function toolNamed(tools: readonly AnyServerTool[], name: string) {
  const execute = tools.find((candidate) => candidate.name === name)?.execute;
  if (!execute) throw new Error(`no ${name}`);
  return execute;
}

describe("Kagi settings", () => {
  test("stays off until a key is registered and Kagi is turned on; removing the key turns it off", async () => {
    const { runtime, tools } = await kagiSetup();
    const kagi = await runtime.runPromise(Kagi);

    expect(await runtime.runPromise(kagi.status)).toEqual({ keyRegistered: false, enabled: false });
    const refused = await runtime.runPromise(Effect.result(kagi.setEnabled(true)));
    expect(Result.isFailure(refused) && refused.failure._tag).toBe("KagiKeyMissing");

    await runtime.runPromise(kagi.registerKey("  sk-test-key  "));
    expect(await runtime.runPromise(kagi.status)).toEqual({ keyRegistered: true, enabled: false });
    expect(await tools()).toEqual([]);

    expect(await runtime.runPromise(kagi.setEnabled(true))).toEqual({
      keyRegistered: true,
      enabled: true,
    });
    expect((await tools()).map((candidate) => candidate.name)).toEqual([
      "kagi_search",
      "kagi_extract",
    ]);

    await runtime.runPromise(kagi.removeKey);
    expect(await runtime.runPromise(kagi.status)).toEqual({ keyRegistered: false, enabled: false });
    expect(await tools()).toEqual([]);
  });
});

describe("Kagi tools", () => {
  test("search sends the SDK request with the stored key and marks snippets as summaries", async () => {
    const { enable, tools, kagi } = await kagiSetup();
    await enable();
    const search = toolNamed(await tools(), "kagi_search");

    const result = await search({ query: "effect schema", limit: 50 });
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
  });

  test("extract keeps page failures, missing pages and cut Markdown apart", async () => {
    const long = "x".repeat(maxPageCharacters + 10);
    const { enable, tools, kagi } = await kagiSetup(() => ({
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
    await enable();
    const extract = toolNamed(await tools(), "kagi_extract");

    const urls = [
      "https://example.com/ok",
      "https://example.com/long",
      "https://example.com/broken",
      "https://example.com/dropped",
    ];
    const result = await extract({ urls });
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

    await expect(extract({ urls: ["file:///etc/hosts"] })).rejects.toThrow("invalid_urls");
    expect(kagi.received).toHaveLength(1);
  });

  test("errors carry their HTTP reason and are not retried", async () => {
    let reply: Reply = { status: 401, body: { error: [] } };
    const { enable, tools, kagi } = await kagiSetup(() => reply);
    await enable();
    const search = toolNamed(await tools(), "kagi_search");

    await expect(search({ query: "a" })).rejects.toThrow("kagi_unauthorized");
    reply = { status: 429, body: { error: [] } };
    await expect(search({ query: "b" })).rejects.toThrow("kagi_rate_limited");
    // A 200 that does not match the SDK schema is not passed off as results.
    reply = { status: 200, body: { data: { search: "nope" } } };
    await expect(search({ query: "c" })).rejects.toThrow("kagi_invalid_response");
    expect(kagi.received).toHaveLength(3);
  });

  test("a key removed after the tools were handed out stops the next call before any request", async () => {
    const { runtime, enable, tools, kagi } = await kagiSetup();
    await enable();
    const search = toolNamed(await tools(), "kagi_search");
    await runtime.runPromise(Effect.flatMap(Kagi, (service) => service.removeKey));

    await expect(search({ query: "after removal" })).rejects.toThrow("kagi_not_enabled");
    expect(kagi.received).toEqual([]);
  });

  test("a chat run offers the tools and their instructions only while Kagi is on", async () => {
    const context = await kagiSetup();
    const { runtime, session, enable } = context;
    await context.provider!.select(runtime);
    const send = async (text: string) => {
      const invocationIndex = context.provider!.adapter.invocations.length;
      const response = await runtime.runPromise(
        Effect.flatMap(AgentChat, (agent) =>
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: session.id,
                runId: `run-${Math.random().toString(36).slice(2)}`,
                messages: [{ id: "m1", role: "user", content: text }],
                tools: [],
                context: [],
              }),
            }),
            session.id,
          ),
        ),
      );
      const events = await response.text();
      const invocation = context.provider!.adapter.invocations[invocationIndex];
      return { events, invocation };
    };

    const off = await send("hello");
    expect(off.invocation?.toolNames).not.toContain("kagi_search");
    expect(off.invocation?.systemPrompts.join("\n")).not.toContain("Kagi web search is enabled");

    await enable();
    const on = await send('call kagi_search {"query":"effect schema"}');
    expect(on.invocation?.toolNames).toContain("kagi_search");
    expect(on.invocation?.systemPrompts.join("\n")).toContain("Kagi web search is enabled");
    expect(on.events).toContain("summary of A");
    expect(on.events).not.toContain("sk-test-key");
  });
});
