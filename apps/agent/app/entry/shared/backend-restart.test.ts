import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import { appFetch, backendFetch, responseRequiresBackendRestart } from "./backend-restart.ts";
import {
  createDevelopmentBoundary,
  developmentRequestDecision,
} from "../../../server/dev-safety.ts";

const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });

describe("development backend restart detection", () => {
  it.effect("direct backend requests carry the client build ID and preserve session headers", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>((_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-session-holder")).toBe("holder");
        expect(
          developmentRequestDecision(
            createDevelopmentBoundary({ buildId: "build-a" }),
            "POST",
            "/api/chat",
            headers.get("x-context-agent-build-id") ?? undefined,
          ),
        ).toEqual({ kind: "allow" });
        return Promise.resolve(Response.json({ ok: true }));
      });
      const request = backendFetch("build-a", "http://localhost:5180", transport);
      yield* call(() =>
        request(
          new Request("http://localhost:5180/api/chat", {
            method: "POST",
            headers: { "x-session-holder": "holder" },
          }),
        ),
      );
      expect(transport).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("never sends the build ID to another origin or retries a stale mutation", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ error: "backend_restart_required" }, { status: 409 })),
      );
      const request = backendFetch("build-a", "http://localhost:5180", transport);
      yield* call(() => request("https://example.com/api/chat", { method: "POST" }));
      expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
      yield* call(() =>
        request("/api/chat", { method: "POST", headers: { "x-session-holder": "holder" } }),
      );
      expect(transport).toHaveBeenCalledTimes(2);
      expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("x-session-holder")).toBe(
        "holder",
      );
    }),
  );

  it.effect("recognizes both stable-backend rejection responses without consuming the body", () =>
    Effect.gen(function* () {
      for (const error of ["backend_restart_required", "backend_restarting"] as const) {
        const response = Response.json(
          { error },
          { status: error === "backend_restarting" ? 503 : 409 },
        );

        expect(yield* call(() => responseRequiresBackendRestart(response))).toBe(true);
        expect(yield* call(() => response.json())).toEqual({ error });
      }
    }),
  );

  it.effect("ignores unrelated and successful responses", () =>
    Effect.gen(function* () {
      expect(
        yield* call(() =>
          responseRequiresBackendRestart(
            Response.json({ error: "run_in_progress" }, { status: 409 }),
          ),
        ),
      ).toBe(false);
      expect(
        yield* call(() =>
          responseRequiresBackendRestart(Response.json({ error: "backend_restart_required" })),
        ),
      ).toBe(false);
    }),
  );
});

describe("official HTTP client SDK transport", () => {
  it.live("preserves multipart boundary and bytes without converting uploads to streams", () =>
    Effect.gen(function* () {
      const form = new FormData();
      form.set("holder", "page");
      form.set("attachment", new Blob([new Uint8Array([0, 255, 13, 10])]), "probe.bin");
      const transport = vi.fn<typeof fetch>((_input, init) => {
        expect(init?.body).toBeInstanceOf(Uint8Array);
        const response = new Response(init?.body, { headers: init?.headers });
        return response
          .formData()
          .then((received) => {
            expect(received.get("holder")).toBe("page");
            const file = received.get("attachment");
            expect(file).toBeInstanceOf(File);
            return file instanceof File ? file.arrayBuffer() : null;
          })
          .then((bytes) => {
            if (bytes !== null)
              expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0, 255, 13, 10]));
            return Response.json({ ok: true });
          });
      });
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() =>
        appFetch("http://localhost/api/attachments", { method: "POST", body: form }),
      );
      expect(yield* call(() => response.json())).toEqual({ ok: true });
    }),
  );
  it.live("preserves incremental SSE, status, headers and independent clones", () =>
    Effect.gen(function* () {
      const text = "id: 1\ndata: first\n\nid: 2\ndata: second\n\n";
      const transport = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(text.slice(0, 20)));
                controller.enqueue(new TextEncoder().encode(text.slice(20)));
                controller.close();
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream", "x-session-holder": "h" },
            },
          ),
        ),
      );
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() => appFetch("http://localhost/api/chat"));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-session-holder")).toBe("h");
      const copy = response.clone();
      const reader = response.body!.getReader();
      const first = yield* call(() => reader.read());
      expect(new TextDecoder().decode(first.value)).toBe(text.slice(0, 20));
      const second = yield* call(() => reader.read());
      expect(new TextDecoder().decode(second.value)).toBe(text.slice(20));
      expect((yield* call(() => reader.read())).done).toBe(true);
      expect(yield* call(() => copy.text())).toBe(text);
    }),
  );
  it.live("forwards Request bodies and credentials through the official client", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>((_input, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("include");
        expect(init?.body).not.toBeInstanceOf(ReadableStream);
        return new Response(init?.body).text().then((body) => Response.json({ body }));
      });
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() =>
        appFetch(
          new Request("http://localhost/api/chat", {
            method: "POST",
            body: "request body",
            credentials: "include",
          }),
        ),
      );
      expect(yield* call(() => response.json())).toEqual({ body: "request body" });
    }),
  );

  it.live("keeps JSON lease uploads buffered over HTTP/1.1, including keepalive", () =>
    Effect.gen(function* () {
      vi.stubGlobal("location", new URL("http://localhost:5173/?session=target"));
      const transport = vi.fn<typeof fetch>((input, init) => {
        expect(input instanceof Request ? input.url : String(input)).toBe(
          "http://localhost:5173/api/sessions/target/lease",
        );
        expect(init?.body).toBe('{"holder":"page","action":"claim"}');
        expect(init?.keepalive).toBe(true);
        expect(init?.body).not.toBeInstanceOf(ReadableStream);
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        return Promise.resolve(Response.json({ state: "mine" }));
      });
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() =>
        appFetch("/api/sessions/target/lease", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"holder":"page","action":"claim"}',
          keepalive: true,
        }),
      );
      expect(yield* call(() => response.json())).toEqual({ state: "mine" });
      expect(transport).toHaveBeenCalledOnce();
    }),
  );
  it.live("aborts pending response bodies and cancels their network scope", () => {
    const abort = new AbortController();
    return Effect.gen(function* () {
      let transportSignal: AbortSignal | undefined;
      const transport = vi.fn<typeof fetch>((_input, init) => {
        transportSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
              },
            }),
          ),
        );
      });
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() =>
        appFetch("http://localhost/api/chat", { signal: abort.signal }),
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((yield* call(() => reader.read())).value)).toBe("first");
      abort.abort();
      yield* call(() => expect(reader.read()).rejects.toBeDefined());
      expect(transportSignal?.aborted).toBe(true);
    });
  });
});

it.live("SDK cancellation before headers and body reader cancellation close the HTTP scope", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_input, init) =>
        runNative(
          Effect.callback<Response, DOMException>((resume) => {
            const aborted = () => resume(Effect.fail(new DOMException("Aborted", "AbortError")));
            if (init?.signal?.aborted === true) aborted();
            else init?.signal?.addEventListener("abort", aborted, { once: true });
            return Effect.sync(() => init?.signal?.removeEventListener("abort", aborted));
          }),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
    const pending = appFetch("http://localhost/api/chat", { signal: controller.signal });
    controller.abort();
    yield* call(() => expect(pending).rejects.toBeDefined());

    let transportSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_input, init) => {
        transportSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode("pending SSE"));
              },
            }),
          ),
        );
      }),
    );
    const response = yield* call(() => appFetch("http://localhost/api/chat"));
    const reader = response.body!.getReader();
    yield* call(() => reader.read());
    yield* call(() => reader.cancel());
    expect(transportSignal?.aborted).toBe(true);
  });
});

it.live(
  "resolves relative SDK requests against the document location and preserves native transport failures",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("location", new URL("https://example.test/projects/current"));
      const transport = vi.fn<typeof fetch>((input) => {
        expect(input instanceof URL ? input.href : input).toBe(
          "https://example.test/projects/api/chat",
        );
        return Promise.resolve(Response.json({ ready: true }));
      });
      vi.stubGlobal("fetch", transport);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const response = yield* call(() => appFetch("api/chat"));
      expect(yield* call(() => response.json())).toEqual({ ready: true });
      const failure = new TypeError("connection unavailable");
      vi.stubGlobal("fetch", () => Promise.reject(failure));
      yield* call(() => expect(appFetch("/api/chat")).rejects.toBe(failure));
    }),
);
