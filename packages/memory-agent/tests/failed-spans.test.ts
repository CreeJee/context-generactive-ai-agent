import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { FailedSpans, failedSpansLayer, runSpanAttribute } from "../src/runtime/failed-spans.ts";

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
});
