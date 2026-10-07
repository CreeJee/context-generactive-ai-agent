import { it } from "@effect/vitest";
import { assertInstanceOf, assertTrue } from "@effect/vitest/utils";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { makeReportClient, ReportRequestFailed } from "./report-client";

const transport = vi.fn<typeof fetch>();
const { readReportDetail, readReportEvidence } = makeReportClient(transport);
const selection = { project: "p1", session: "s1", item: "c1" };
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

it.effect("rejects malformed evidence and details for a different item", () =>
  Effect.gen(function* () {
    transport.mockResolvedValueOnce(Response.json({ session: {} }));
    expect((yield* Effect.flip(readReportEvidence(selection)))._tag).toBe("SchemaError");
    transport.mockResolvedValueOnce(
      Response.json({ id: "different", text: "private", truncated: false }),
    );
    expect((yield* Effect.flip(readReportDetail(selection)))._tag).toBe("SchemaError");
    transport.mockResolvedValueOnce(Response.json({ id: "c1", text: "reviewed", truncated: true }));
    expect(yield* readReportDetail(selection)).toEqual({
      id: "c1",
      text: "reviewed",
      truncated: true,
    });
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
          return Response.json({ id: "c1", text: "late", truncated: false });
        }),
        { signal: init?.signal ?? undefined },
      ),
    );
    const task = yield* Effect.forkChild(readReportDetail(selection));
    const signal = yield* Deferred.await(started);
    yield* Fiber.interrupt(task);
    assertTrue(signal.aborted);
    assertTrue(Exit.hasInterrupts(yield* Fiber.await(task)));
  }),
);
