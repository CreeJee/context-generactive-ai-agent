import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import {
  FailedSpans,
  failedSpansLayer,
  runSpanAttribute,
  workerFailedSpansLayer,
} from "../src/runtime/failed-spans.ts";

class ProviderRejected extends Data.TaggedError("ProviderRejected")<{}> {}

describe("failed span recorder", () => {
  it.effect(
    "keeps a failure once where it began, linked to its run, without string attributes",
    () =>
      Effect.gen(function* () {
        const run = Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan(runSpanAttribute, "run-1");
          yield* Effect.void.pipe(Effect.withSpan("Memory.search"));
          yield* Effect.fail(new ProviderRejected()).pipe(
            Effect.withSpan("LanguageModel.streamText", {
              attributes: { "http.status": 400, url: "http://secret/x", streamed: false },
            }),
          );
        }).pipe(Effect.withSpan("AgentChat.start"));
        yield* Effect.exit(run);

        const spans = (yield* (yield* FailedSpans).ofRuns(["run-1", "run-2"])).get("run-1");
        expect(
          spans?.map(({ path, failure, attributes }) => ({ path, failure, attributes })),
        ).toEqual([
          {
            path: ["AgentChat.start", "LanguageModel.streamText"],
            failure: "ProviderRejected",
            attributes: { "http.status": 400, streamed: false },
          },
        ]);
      }).pipe(Effect.provide(failedSpansLayer)),
  );

  it.live("takes in what a worker thread's recorder sends, under the trace it ran in", () =>
    Effect.gen(function* () {
      const owner = yield* FailedSpans;
      let traceId = "";
      // What a worker does: its own recorder keeps nothing for the report, it sends instead.
      yield* Effect.currentSpan.pipe(
        Effect.tap((span) =>
          Effect.sync(() => {
            traceId = span.traceId;
          }),
        ),
        Effect.andThen(Effect.fail(new ProviderRejected())),
        Effect.withSpan("Embedder.embed", { attributes: { texts: 8 } }),
        Effect.exit,
        Effect.provide(workerFailedSpansLayer),
      );

      // The channel delivers between threads, so the owner sees it a tick later.
      const arrived = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const spans = yield* owner.ofTrace(traceId);
          if (spans.length > 0) return spans;
          yield* Effect.sleep("10 millis");
        }
        return [];
      });
      expect(
        arrived.map(({ path, failure, attributes }) => ({ path, failure, attributes })),
      ).toEqual([
        { path: ["Embedder.embed"], failure: "ProviderRejected", attributes: { texts: 8 } },
      ]);
    }).pipe(Effect.provide(failedSpansLayer)),
  );
});
