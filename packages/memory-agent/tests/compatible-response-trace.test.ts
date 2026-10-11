import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { chat } from "@tanstack/ai";
import { Cause, Effect, FileSystem, Path, Result, Schema, Stream, Logger } from "effect";
import type { Settings } from "../src/config/global-config.ts";
import { makeOpenAICompatibleSettings } from "../src/providers/openai-compatible.ts";
import { traceCompatibleResponse } from "../src/providers/compatible-response-trace.ts";
import { withTestPlatform } from "./support/platform.ts";

const identity = { threadId: "session", runId: "run", adapterId: "adapter", sequence: 2 };
// The SDK exposes native response bodies and promises; keep original errors at this boundary.
const call = Effect.fn("compatibleTrace.call")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const rejects = Effect.fn("compatibleTrace.rejects")(function* <A>(
  operation: () => PromiseLike<A>,
  expected: Error,
) {
  const result = yield* Effect.result(call(operation));
  Result.match(result, {
    onSuccess: () => {
      throw new Error("Expected SDK failure");
    },
    onFailure: (error) => expect(error.cause).toBe(expected),
  });
});
const fixture = Effect.fn("compatibleTrace.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "compatible-response-trace-" });
  const capture = Effect.fn("compatibleTrace.capture")(function* () {
    const files = yield* fs.readDirectory(directory);
    const raw = yield* fs.readFile(
      path.join(
        directory,
        files.find((file) => file.endsWith(".raw"))!,
      ),
    );
    const jsonl = yield* fs.readFileString(
      path.join(
        directory,
        files.find((file) => file.endsWith(".jsonl"))!,
      ),
    );
    // Decode complete records: stripping fields here would invalidate secret-redaction assertions.
    const events = yield* Effect.forEach(jsonl.trim().split("\n"), (line) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
    );
    return { raw, events };
  });
  return { directory, capture };
});

describe("compatible response capture", () => {
  it.live("preserves the response when diagnostic storage is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const f = yield* fixture();
      const log = vi.spyOn(Logger.defaultLogger, "log").mockImplementation(() => {});
      try {
        const directory = path.join(f.directory, "file");
        yield* fs.writeFileString(directory, "not a directory");
        const response = yield* call(() =>
          traceCompatibleResponse({
            directory: directory,
            identity: identity,
            request: () => Promise.resolve(new Response("OK")),
          }),
        );
        expect(yield* call(() => response.text())).toBe("OK");
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0]?.[0]).toMatchObject({
          logLevel: "Error",
          message: ["Compatible response trace write failed", expect.any(Object)],
        });
      } finally {
        log.mockRestore();
      }
    }).pipe(withTestPlatform),
  );

  it.live("records request cancellation before headers separately from transport failure", () => {
    // The SDK request is already cancelled before the Effect test starts.
    const controller = new AbortController();
    controller.abort();
    return Effect.gen(function* () {
      const f = yield* fixture();
      {
        yield* rejects(
          () =>
            traceCompatibleResponse({
              directory: f.directory,
              identity: identity,
              request: () => Promise.reject(controller.signal.reason),
              signal: controller.signal,
            }),
          controller.signal.reason,
        );
        expect((yield* f.capture()).events.at(-1)).toMatchObject({
          kind: "cancelled",
          phase: "headers",
        });
      }
    }).pipe(withTestPlatform);
  });
  it.live("links SDK requests to their session and run while preserving parsed events", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const configuration = {
        baseUrl: "http://localhost/v1",
        model: "local",
        contextWindow: 8192,
        outputBudget: 128,
        toolCalling: false,
      };
      let saved: Settings = { openaiCompatible: configuration };
      const raw =
        'data: {"id":"completion","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"completion","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      const settings = makeOpenAICompatibleSettings({
        config: {
          read: Effect.sync(() => saved),
          update: (patch) => Effect.sync(() => (saved = { ...saved, ...patch })),
        },
        keys: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
        fetcher: () =>
          Promise.resolve(
            new Response(raw, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        traceDirectory: f.directory,
      });
      const adapter = settings.services.runtime.adapter({
        provider: "openai-compatible",
        model: "local",
        reasoningEffort: "default",
      });
      try {
        const chunks = [];
        chunks.push(
          ...(yield* Stream.runCollect(
            Stream.fromAsyncIterable(
              chat({
                adapter,
                messages: [{ role: "user", content: "Hello" }],
                threadId: "session",
                runId: "run",
              }),
              (cause) => new Cause.UnknownError(cause),
            ),
          )),
        );
        expect(chunks).toContainEqual(
          expect.objectContaining({ type: "TEXT_MESSAGE_CONTENT", delta: "OK" }),
        );
        const capture = yield* f.capture();
        expect(new TextDecoder().decode(capture.raw)).toBe(raw);
        expect(capture.events[0]).toMatchObject({ threadId: "session", runId: "run", sequence: 1 });
      } finally {
        adapter.releaseRun?.();
      }
    }).pipe(withTestPlatform),
  );
  it.live("preserves split UTF-8 bytes and records completion with safe correlation headers", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      {
        const raw = new TextEncoder().encode("data: 한글\n\ndata: [DONE]\n\n");
        let reads = 0;
        const response = yield* call(() =>
          traceCompatibleResponse({
            directory: f.directory,
            identity: identity,
            request: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream(
                    {
                      pull(controller) {
                        reads++;
                        switch (reads) {
                          case 1:
                            controller.enqueue(raw.subarray(0, 7));
                            break;
                          case 2:
                            controller.enqueue(raw.subarray(7));
                            break;
                          default:
                            controller.close();
                        }
                      },
                    },
                    { highWaterMark: 0 },
                  ),
                  { headers: { "x-litellm-call-id": "call", "set-cookie": "secret" } },
                ),
              ),
          }),
        );
        expect(reads).toBe(0);
        expect(new Uint8Array(yield* call(() => response.arrayBuffer()))).toEqual(raw);
        const capture = yield* f.capture();
        expect(new Uint8Array(capture.raw)).toEqual(raw);
        expect(capture.events[0]).toMatchObject(identity);
        expect(capture.events[1]).toMatchObject({
          kind: "headers",
          headers: { "x-litellm-call-id": "call" },
        });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
            capture.events,
          ),
        ).not.toContain("secret");
        expect(capture.events.at(-1)).toMatchObject({
          kind: "completed",
          phase: "body",
          chunks: 2,
          truncated: false,
        });
      }
    }).pipe(withTestPlatform),
  );

  it.live("keeps partial bytes and the original body error", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = Object.assign(new Error("private provider traceback"), {
        code: "UND_ERR_SOCKET",
      });
      {
        let reads = 0;
        const response = yield* call(() =>
          traceCompatibleResponse({
            directory: f.directory,
            identity: identity,
            request: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream(
                    {
                      pull(controller) {
                        if (reads++ === 0)
                          controller.enqueue(new TextEncoder().encode("data: partial\n"));
                        else controller.error(error);
                      },
                    },
                    { highWaterMark: 0 },
                  ),
                ),
              ),
          }),
        );
        yield* rejects(() => response.text(), error);
        const capture = yield* f.capture();
        expect(new TextDecoder().decode(capture.raw)).toBe("data: partial\n");
        expect(capture.events.at(-1)).toMatchObject({
          kind: "failed",
          phase: "body",
          codes: ["UND_ERR_SOCKET"],
        });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
            capture.events,
          ),
        ).not.toContain(error.message);
      }
    }).pipe(withTestPlatform),
  );

  it.live("distinguishes a failure before response headers", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = new TypeError("fetch failed", {
        cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }),
      });
      {
        yield* rejects(
          () =>
            traceCompatibleResponse({
              directory: f.directory,
              identity: identity,
              request: () => Promise.reject(error),
            }),
          error,
        );
        const capture = yield* f.capture();
        expect(capture.raw.length).toBe(0);
        expect(capture.events.at(-1)).toMatchObject({
          kind: "failed",
          phase: "headers",
          bytes: 0,
          codes: ["UND_ERR_SOCKET"],
        });
      }
    }).pipe(withTestPlatform),
  );

  it.live("forwards consumer cancellation without draining the response", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let cancelled: unknown;
      {
        const response = yield* call(() =>
          traceCompatibleResponse({
            directory: f.directory,
            identity: identity,
            request: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream(
                    {
                      cancel(reason) {
                        cancelled = reason;
                      },
                    },
                    { highWaterMark: 0 },
                  ),
                ),
              ),
          }),
        );
        yield* call(() => response.body!.cancel("stop"));
        expect(cancelled).toBe("stop");
        expect((yield* f.capture()).events.at(-1)).toMatchObject({ kind: "cancelled", bytes: 0 });
      }
    }).pipe(withTestPlatform),
  );
});
