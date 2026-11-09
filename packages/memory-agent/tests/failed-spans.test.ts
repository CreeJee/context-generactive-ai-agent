import { expect, layer } from "@effect/vitest";
import { Data, Deferred, Effect, HashMap, Layer, Option, Schedule } from "effect";
import {
  FailedSpans,
  failedSpansLayer,
  runSpanAttribute,
  workerFailedSpansLayer,
} from "../src/runtime/failed-spans.ts";

class ProviderRejected extends Data.TaggedError("ProviderRejected")<{}> {}
class ProviderUnreachable extends Data.TaggedError("ProviderUnreachable")<{
  readonly cause: unknown;
}> {}

// Live services: a worker's spans reach the owner through a real channel, a tick later.
layer(failedSpansLayer, { excludeTestServices: true })("failed span recorder", (it) => {
  it.effect(
    "keeps a failure once where it began, linked to its run, without string attributes",
    () =>
      Effect.gen(function* () {
        const run = Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan(runSpanAttribute, "run-1");
          yield* Effect.void.pipe(Effect.withSpan("Memory.search"));
          return yield* Effect.fail(new ProviderRejected()).pipe(
            Effect.withSpan("LanguageModel.streamText", {
              attributes: { "http.status": 400, url: "http://secret/x", streamed: false },
            }),
          );
        }).pipe(Effect.withSpan("AgentChat.start"));
        yield* Effect.exit(run);

        const spans = Option.getOrUndefined(
          HashMap.get(yield* (yield* FailedSpans).ofRuns(["run-1", "run-2"]), "run-1"),
        );
        expect(
          spans?.map(({ path, failure, attributes }) => ({ path, failure, attributes })),
        ).toEqual([
          {
            path: ["AgentChat.start", "LanguageModel.streamText"],
            failure: "ProviderRejected",
            attributes: { "http.status": 400, streamed: false },
          },
        ]);
      }),
  );

  it.effect("names how a request failed by the error codes down its cause", () =>
    Effect.gen(function* () {
      const unreachable = new ProviderUnreachable({
        cause: new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:80"), {
            code: "ECONNREFUSED",
          }),
        }),
      });
      const run = Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(runSpanAttribute, "run-3");
        return yield* Effect.fail(unreachable).pipe(Effect.withSpan("POST"));
      }).pipe(Effect.withSpan("AgentChat.start"));
      yield* Effect.exit(run);

      const spans = Option.getOrUndefined(
        HashMap.get(yield* (yield* FailedSpans).ofRuns(["run-3"]), "run-3"),
      );
      expect(spans?.map((span) => span.failure)).toEqual(["ProviderUnreachable (ECONNREFUSED)"]);
    }),
  );

  it.effect("sums every span of a run's trace by its path, and nothing of other traces", () =>
    Effect.gen(function* () {
      const run = Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan(runSpanAttribute, "run-4");
        yield* Effect.void.pipe(Effect.withSpan("Memory.search"));
        yield* Effect.void.pipe(Effect.withSpan("Memory.search"));
        return yield* Effect.fail(new ProviderRejected()).pipe(
          Effect.withSpan("LanguageModel.streamText"),
        );
      }).pipe(Effect.withSpan("AgentChat.start"));
      yield* Effect.exit(run);
      // A trace no run named, such as a page's request, is not summed.
      yield* Effect.void.pipe(Effect.withSpan("Sessions.list"));

      const recorded = Option.getOrUndefined(
        HashMap.get(yield* (yield* FailedSpans).totalsOfRuns(["run-4", "run-5"]), "run-4"),
      );
      expect(recorded?.dropped).toBe(0);
      expect(
        recorded?.totals
          .map(({ path, count, failed }) => ({ path, count, failed }))
          .toSorted((left, right) => left.path.join().localeCompare(right.path.join())),
      ).toEqual([
        { path: ["AgentChat.start"], count: 1, failed: 1 },
        { path: ["AgentChat.start", "LanguageModel.streamText"], count: 1, failed: 1 },
        { path: ["AgentChat.start", "Memory.search"], count: 2, failed: 0 },
      ]);
      // Longest first: the run's own span holds the others.
      expect(recorded?.totals[0]?.path).toEqual(["AgentChat.start"]);
    }),
  );

  it.effect("takes in what a worker thread's recorder sends, under the trace it ran in", () =>
    Effect.gen(function* () {
      const owner = yield* FailedSpans;
      const worker = yield* Layer.build(workerFailedSpansLayer);
      const trace = yield* Deferred.make<string>();
      // What a worker does: its own recorder keeps nothing for the report, it sends instead.
      yield* Effect.currentSpan.pipe(
        Effect.tap((span) => Deferred.succeed(trace, span.traceId)),
        Effect.andThen(Effect.fail(new ProviderRejected())),
        Effect.withSpan("Embedder.embed", { attributes: { texts: 8 } }),
        Effect.exit,
        Effect.provide(worker),
      );

      const traceId = yield* Deferred.await(trace);
      // The channel delivers between threads, so the owner sees it a tick later.
      const arrived = yield* owner.ofTrace(traceId).pipe(
        Effect.repeat({
          until: (spans) => spans.length > 0,
          times: 99,
          schedule: Schedule.spaced("10 millis"),
        }),
      );
      expect(
        arrived.map(({ path, failure, attributes }) => ({ path, failure, attributes })),
      ).toEqual([
        { path: ["Embedder.embed"], failure: "ProviderRejected", attributes: { texts: 8 } },
      ]);
    }),
  );
});
