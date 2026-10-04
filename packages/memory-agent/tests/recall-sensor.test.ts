import { createServer } from "node:http";
import { once } from "node:events";
import { Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createRecallSensor, layaSensorVersion } from "../src/agent/recall-sensor.ts";

const endpoint = "http://127.0.0.1:8765/v1/systemone";
const input = { turnId: "turn-1", redactedText: "What did we decide?" };
const reply = (yes: number | string | null) =>
  Response.json({ answers: { recall_useful: { type: "noul", noul: yes } } });
const requestBody = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    questions: Schema.Struct({
      recall_useful: Schema.Struct({ type: Schema.Literal("noul"), instructions: Schema.String }),
    }),
    model: Schema.String,
  }),
);

test("disabled by default and resource guard skips without evaluating", async () => {
  expect(await createRecallSensor().evaluate(input)).toEqual({
    status: "disabled",
    version: layaSensorVersion,
  });
  const evaluate = vi.fn(() => 0.5);
  const sensor = createRecallSensor({ mode: "mock", evaluate });
  expect(await sensor.evaluate({ ...input, resourceAllowed: false })).toEqual({
    status: "skipped",
    version: "mock",
  });
  expect(evaluate).not.toHaveBeenCalled();
});

test("mock is replaceable, bounded input and once per turn", async () => {
  const evaluate = vi.fn(async (_text: string) => 0.75);
  const sensor = createRecallSensor({ mode: "mock", evaluate, version: "fixture" });
  const turn = { ...input, redactedText: "x".repeat(3000) };
  const [first, second] = await Promise.all([sensor.evaluate(turn), sensor.evaluate(turn)]);
  expect(first).toEqual({ status: "evaluated", version: "fixture", score: 0.75 });
  expect(second).toEqual(first);
  expect(evaluate).toHaveBeenCalledOnce();
  expect(evaluate.mock.calls[0]?.[0]).toHaveLength(2048);
});

test("HTTP posts typed noul only to loopback and does not follow redirects", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(Schema.decodeUnknownSync(requestBody)(init?.body)).toEqual({
      state: input.redactedText,
      questions: {
        recall_useful: {
          type: "noul",
          instructions: "Would recalling earlier conversation context help answer this turn?",
        },
      },
      model: "multilingual",
    });
    return reply(0.42);
  });
  const sensor = createRecallSensor({ mode: "http", endpoint, fetch: fetcher });
  expect(await sensor.evaluate(input)).toEqual({
    status: "evaluated",
    version: layaSensorVersion,
    score: 0.42,
  });
  expect(await sensor.evaluate(input)).toEqual({
    status: "evaluated",
    version: layaSensorVersion,
    score: 0.42,
  });
  expect(fetcher).toHaveBeenCalledOnce();
  const redirect = createRecallSensor({
    mode: "http",
    endpoint,
    fetch: vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://example.com" } }),
    ),
  });
  expect((await redirect.evaluate(input)).status).toBe("error");
});

test("HTTP transport works with a short-lived loopback-only synthetic server", async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requests.push(Schema.decodeUnknownSync(requestBody)(Buffer.concat(parts).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answers: { recall_useful: { type: "noul", noul: 0.6 } } }));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const sensor = createRecallSensor({
      mode: "http",
      endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    });
    expect(await sensor.evaluate(input)).toEqual({
      status: "evaluated",
      version: layaSensorVersion,
      score: 0.6,
    });
    expect(requests).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test.each([
  "https://127.0.0.1/v1/systemone",
  "http://localhost/v1/systemone",
  "http://127.0.0.2/v1/systemone",
  "http://user@127.0.0.1/v1/systemone",
  "http://[::2]/v1/systemone",
  "http://127.0.0.1/v1/systemone?next=1",
  "http://127.0.0.1/other",
  "http://example.com/v1/systemone",
  "http://2130706433/v1/systemone",
  "http://0x7f000001/v1/systemone",
  "http://127.0.0.1@evil.example/v1/systemone",
])("rejects nonliteral endpoint %s", async (bad) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await createRecallSensor({ mode: "http", endpoint: bad, fetch: fetcher }).evaluate(input))
      .status,
  ).toBe("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([NaN, Infinity, -0.01, 1.01, "0.5", null])("rejects malformed score %s", async (yes) => {
  const sensor = createRecallSensor({ mode: "http", endpoint, fetch: async () => reply(yes) });
  expect((await sensor.evaluate(input)).status).toBe("error");
});

test("failure has no content-bearing result", async () => {
  const sensor = createRecallSensor({
    mode: "http",
    endpoint,
    fetch: async () => {
      throw new Error(input.redactedText);
    },
  });
  expect(await sensor.evaluate(input)).toEqual({ status: "error", version: layaSensorVersion });
});

test("times out even if injected fetch ignores abort", async () => {
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const sensor = createRecallSensor({ mode: "http", endpoint, timeoutMs: 5, fetch: fetcher });
  expect(await sensor.evaluate(input)).toEqual({ status: "timeout", version: layaSensorVersion });
});

test("cancellation aborts in-flight request and returns no score", async () => {
  const abort = new AbortController();
  let wireSignal: AbortSignal | undefined;
  const sensor = createRecallSensor({
    mode: "http",
    endpoint,
    fetch: async (_, init) => {
      wireSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    },
  });
  const pending = sensor.evaluate({ ...input, signal: abort.signal });
  abort.abort();
  expect(await pending).toEqual({ status: "cancelled", version: layaSensorVersion });
  expect(wireSignal?.aborted).toBe(true);
});
