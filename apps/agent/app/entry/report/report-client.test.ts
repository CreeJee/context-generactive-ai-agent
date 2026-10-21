import { it } from "@effect/vitest";
import { assertInstanceOf, assertTrue } from "@effect/vitest/utils";
import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { makeReportClient, ReportRequestFailed } from "./report-client";

const transport = vi.fn<typeof fetch>();
const { readReportEvidence } = makeReportClient(transport);
const selection = { project: "p1", session: "s1" };
beforeEach(() => {
  transport.mockReset();
});

it.effect("keeps a rejected response typed without reading private server details", () =>
  Effect.gen(function* () {
    const response = new Response("private server diagnostic", { status: 503 });
    transport.mockResolvedValue(response);
    const failure = yield* Effect.flip(readReportEvidence(selection));
    assertInstanceOf(failure, ReportRequestFailed);
    expect(failure.phase).toBe("status");
    expect(response.bodyUsed).toBe(false);
  }),
);

it.effect("rejects a malformed evidence bundle", () =>
  Effect.gen(function* () {
    transport.mockResolvedValueOnce(Response.json({ session: {} }));
    assertInstanceOf(yield* Effect.flip(readReportEvidence(selection)), Schema.SchemaError);
  }),
);

it.effect("aborts the scoped transport when its owning request is interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    const blocked = yield* Deferred.make<void>();
    const context = yield* Effect.context<never>();
    transport.mockImplementation((_input, init) =>
      Effect.runPromiseWith(context)(
        Effect.gen(function* () {
          const signal = init?.signal;
          if (signal === undefined || signal === null)
            return yield* Effect.die("missing request signal");
          yield* Deferred.succeed(started, signal);
          yield* Deferred.await(blocked);
          return Response.json({});
        }),
        { signal: init?.signal ?? undefined },
      ),
    );
    const task = yield* Effect.forkChild(readReportEvidence(selection));
    const signal = yield* Deferred.await(started);
    yield* Fiber.interrupt(task);
    assertTrue(signal.aborted);
    assertTrue(Exit.hasInterrupts(yield* Fiber.await(task)));
  }),
);
