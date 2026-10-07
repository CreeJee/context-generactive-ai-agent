import { Cause, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { it } from "@effect/vitest";
// Native fetch and HTTP server fixtures exercise the actual SDK transport.
import { createServer } from "node:http";
import { expect, vi } from "vite-plus/test";
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

it.live("disabled by default and resource guard skips without evaluating", () =>
  Effect.gen(function* () {
    expect(yield* sdkCall(() => createRecallSensor().evaluate(input))).toEqual({
      status: "disabled",
      version: layaSensorVersion,
    });
    const evaluate = vi.fn(() => 0.5);
    const sensor = createRecallSensor({ mode: "mock", evaluate });
    expect(yield* sdkCall(() => sensor.evaluate({ ...input, resourceAllowed: false }))).toEqual({
      status: "skipped",
      version: "mock",
    });
    expect(evaluate).not.toHaveBeenCalled();
  }),
);

it.live("mock is replaceable, bounded input and once per turn", () =>
  Effect.gen(function* () {
    const evaluate = vi.fn((_text: string) => Promise.resolve(0.75));
    const sensor = createRecallSensor({ mode: "mock", evaluate, version: "fixture" });
    const turn = { ...input, redactedText: "x".repeat(3000) };
    const [first, second] = yield* Effect.all(
      [sdkCall(() => sensor.evaluate(turn)), sdkCall(() => sensor.evaluate(turn))],
      { concurrency: "unbounded" },
    );
    expect(first).toEqual({ status: "evaluated", version: "fixture", score: 0.75 });
    expect(second).toEqual(first);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toHaveLength(2048);
  }),
);

it.live("HTTP posts typed noul only to loopback and does not follow redirects", () =>
  Effect.gen(function* () {
    const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
    const fetcher = vi.fn<typeof fetch>((url, init) =>
      runNative(
        Effect.gen(function* () {
          expect(url).toBe(endpoint);
          expect(init?.method).toBe("POST");
          expect(init?.redirect).toBe("manual");
          expect(yield* Schema.decodeUnknownEffect(requestBody)(init?.body)).toEqual({
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
        }),
      ),
    );
    const sensor = createRecallSensor({ mode: "http", endpoint, fetch: fetcher });
    expect(yield* sdkCall(() => sensor.evaluate(input))).toEqual({
      status: "evaluated",
      version: layaSensorVersion,
      score: 0.42,
    });
    expect(yield* sdkCall(() => sensor.evaluate(input))).toEqual({
      status: "evaluated",
      version: layaSensorVersion,
      score: 0.42,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const redirect = createRecallSensor({
      mode: "http",
      endpoint,
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { Location: "https://example.com" } }),
        ),
      ),
    });
    expect((yield* sdkCall(() => redirect.evaluate(input))).status).toBe("error");
  }),
);

it.live("HTTP transport works with a short-lived loopback-only synthetic server", () =>
  Effect.gen(function* () {
    const requests: unknown[] = [];
    const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
    const server = createServer((request, response) => {
      void runNative(
        Effect.gen(function* () {
          const parts = yield* Stream.runCollect(
            Stream.fromAsyncIterable(request, (cause) => new Cause.UnknownError(cause)),
          );
          requests.push(
            yield* Schema.decodeEffect(requestBody)(
              Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8"),
            ),
          );
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            yield* Schema.encodeEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  answers: Schema.Struct({
                    recall_useful: Schema.Struct({
                      type: Schema.Literal("noul"),
                      noul: Schema.Finite,
                    }),
                  }),
                }),
              ),
            )({ answers: { recall_useful: { type: "noul", noul: 0.6 } } }),
          );
        }).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              response.writeHead(400);
              response.end();
            }),
          ),
        ),
      );
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, Cause.UnknownError>((resume) => {
        const failed = (cause: Error) => resume(Effect.fail(new Cause.UnknownError(cause)));
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
        return Effect.sync(() => server.off("error", failed));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
      server.address(),
    );
    const sensor = createRecallSensor({
      mode: "http",
      endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    });
    expect(yield* sdkCall(() => sensor.evaluate(input))).toEqual({
      status: "evaluated",
      version: layaSensorVersion,
      score: 0.6,
    });
    expect(requests).toHaveLength(1);
  }),
);

it.live.each([
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
])("rejects nonliteral endpoint %s", (bad) =>
  Effect.gen(function* () {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (yield* sdkCall(() =>
        createRecallSensor({ mode: "http", endpoint: bad, fetch: fetcher }).evaluate(input),
      )).status,
    ).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  }),
);

it.live.each([NaN, Infinity, -0.01, 1.01, "0.5", null])("rejects malformed score %s", (yes) =>
  Effect.gen(function* () {
    const sensor = createRecallSensor({
      mode: "http",
      endpoint,
      fetch: () => Promise.resolve(reply(yes)),
    });
    expect((yield* sdkCall(() => sensor.evaluate(input))).status).toBe("error");
  }),
);

it.live("failure has no content-bearing result", () =>
  Effect.gen(function* () {
    const sensor = createRecallSensor({
      mode: "http",
      endpoint,
      fetch: () => Promise.reject(new Error(input.redactedText)),
    });
    expect(yield* sdkCall(() => sensor.evaluate(input))).toEqual({
      status: "error",
      version: layaSensorVersion,
    });
  }),
);

it.live("times out even if injected fetch ignores abort", () =>
  Effect.gen(function* () {
    const hang = yield* hangingResponse();
    const fetcher = vi.fn<typeof fetch>(() => hang());
    const sensor = createRecallSensor({ mode: "http", endpoint, timeoutMs: 5, fetch: fetcher });
    expect(yield* sdkCall(() => sensor.evaluate(input))).toEqual({
      status: "timeout",
      version: layaSensorVersion,
    });
  }),
);

it.live("cancellation aborts in-flight request and returns no score", () => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const hang = yield* hangingResponse();
    let wireSignal: AbortSignal | undefined;
    const sensor = createRecallSensor({
      mode: "http",
      endpoint,
      fetch: (_, init) => {
        wireSignal = init?.signal ?? undefined;
        return hang();
      },
    });
    const pending = sensor.evaluate({ ...input, signal: abort.signal });
    abort.abort();
    expect(yield* sdkCall(() => pending)).toEqual({
      status: "cancelled",
      version: layaSensorVersion,
    });
    expect(wireSignal?.aborted).toBe(true);
  });
});

const sdkCall = Effect.fn("RecallSensorTest.sdkCall")(<A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);

const hangingResponse = Effect.fn("RecallSensorTest.hangingResponse")(function* () {
  const reply = yield* Deferred.make<Response>();
  const scope = yield* Effect.scope;
  const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
  const fiber = yield* Effect.forkIn(Deferred.await(reply), scope);
  yield* Effect.addFinalizer(() => Deferred.succeed(reply, new Response(null)));
  const promise = runNative(Fiber.join(fiber).pipe(Effect.uninterruptible));
  return () => promise;
});
