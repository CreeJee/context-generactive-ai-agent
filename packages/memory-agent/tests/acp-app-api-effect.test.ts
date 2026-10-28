import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AppRequestReason, createAppApi } from "../src/acp/app-api.ts";

it.effect("classifies transport, rejection and invalid response failures", () =>
  Effect.gen(function* () {
    const response = Schema.Struct({ status: Schema.String });
    const transport = createAppApi("http://localhost", () =>
      Promise.reject(new Error("private transport detail")),
    );
    const unreachable = yield* Effect.flip(transport.request(response, "/api/auth"));
    expect(AppRequestReason.guards.TransportFailed(unreachable.reason)).toBe(true);
    expect(unreachable.code).toBe("unreachable");
    expect(unreachable.message).not.toContain("private");

    const rejected = createAppApi("http://localhost", () =>
      Promise.resolve(new Response("invalid JSON", { status: 403 })),
    );
    const forbidden = yield* Effect.flip(rejected.request(response, "/api/auth"));
    expect(AppRequestReason.guards.RequestRejected(forbidden.reason)).toBe(true);
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe("request_failed");

    const malformed = createAppApi("http://localhost", () =>
      Promise.resolve(Response.json({ status: 42, private: "internal response detail" })),
    );
    const invalid = yield* Effect.flip(malformed.request(response, "/api/auth"));
    expect(AppRequestReason.guards.InvalidResponse(invalid.reason)).toBe(true);
    expect(invalid.code).toBe("unexpected_response");
    expect(invalid.message).not.toContain("internal");
  }),
);

it.effect("interrupts the native request through its Effect-owned signal", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const started = yield* Deferred.make<AbortSignal>();
    const response = yield* Deferred.make<Response>();
    const client = createAppApi("http://localhost", (_url, init) => {
      const signal = init?.signal;
      if (signal == null) return Promise.reject(new Error("missing request signal"));
      return Effect.runPromiseWith(context)(
        Deferred.succeed(started, signal).pipe(Effect.andThen(Deferred.await(response))),
      );
    });
    yield* Effect.acquireUseRelease(
      Effect.forkChild(client.request(Schema.Unknown, "/api/auth")),
      (running) =>
        Effect.gen(function* () {
          const signal = yield* Deferred.await(started);
          yield* Fiber.interrupt(running);
          expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
          expect(signal.aborted).toBe(true);
        }),
      () => Deferred.succeed(response, Response.json({})),
    );
  }),
);
