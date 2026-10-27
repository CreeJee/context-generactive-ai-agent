import { it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { Prompt } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import {
  subscriptionFailure,
  subscriptionModel,
  SubscriptionStreamFailed,
  SubscriptionStreamFailedReason,
  type StreamingOAuthClient,
} from "../../src/model/subscription.ts";
import { unsentRetried, type UnsentRetry } from "../../src/model/unsent-retry.ts";
import {
  NormalizedStreamEvent,
  ProviderStreamFailed,
  RequestNotSent,
} from "../../src/oauth/protocol.ts";
import {
  OAuthHarnessError,
  type SubscriptionClientFailure,
} from "../../src/oauth/validation-harness.ts";
import { ProviderRetryOutcome } from "../../src/workflow/provider-retry.ts";

/**
 * A Goal run's model sends a request again only when the provider never got it
 * (docs/effect-ai-migration.md step 5). Whether a failure reached the provider is runtime state no
 * type shows.
 */

const prompt = Prompt.make([{ role: "user", content: "question" }]);

interface Attempt {
  readonly events: ReadonlyArray<NormalizedStreamEvent>;
  readonly failure?: SubscriptionClientFailure;
}

/** A client whose n-th request yields the n-th attempt's events, then fails with its failure. */
const clientOf = (attempts: ReadonlyArray<Attempt>) => {
  let sent = 0;
  const client: StreamingOAuthClient = {
    stream: () => {
      const attempt = attempts[sent] ?? { events: [] };
      sent += 1;
      return Stream.concat(
        Stream.fromIterable(attempt.events, { chunkSize: 1 }),
        attempt.failure === undefined ? Stream.empty : Stream.fail(attempt.failure),
      );
    },
  };
  return { client, sent: () => sent };
};

/** Streams the request through the retried model; each wait is recorded and answered `outcome`. */
const streamed = Effect.fnUntraced(function* (
  client: StreamingOAuthClient,
  outcome: ProviderRetryOutcome,
  waits: Array<UnsentRetry>,
) {
  const model = unsentRetried(
    yield* subscriptionModel({
      client,
      selection: { provider: "openai", model: "model-1", reasoningEffort: "medium" },
      promptCache: { retention: "short", key: "thread" },
    }),
    (retry) =>
      Effect.sync(() => {
        waits.push(retry);
        return outcome;
      }),
  );
  return yield* Stream.runCollect(
    model.streamText({ prompt, disableToolCallResolution: true, toolCallValidation: "deferred" }),
  );
});

const notSent = ProviderStreamFailed.make({
  provider: "openai",
  reason: RequestNotSent.make({ stage: "dns" }),
});
const failed = (reason: SubscriptionStreamFailed["reason"]) =>
  Option.some(SubscriptionStreamFailed.make({ provider: "openai", reason }));
const reasons = SubscriptionStreamFailedReason.cases;

describe("unsent retry", () => {
  it.effect("sends a request the provider never got again", () =>
    Effect.gen(function* () {
      const waits: Array<UnsentRetry> = [];
      const { client, sent } = clientOf([
        { events: [], failure: notSent },
        { events: [NormalizedStreamEvent.text({ text: "answer" })] },
      ]);
      const parts = yield* streamed(client, ProviderRetryOutcome.Retry(), waits);
      expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))).toEqual([
        "answer",
      ]);
      expect(waits).toMatchObject([{ retry: 1, stage: "dns" }]);
      expect(sent()).toBe(2);
    }),
  );

  it.effect("never sends again a request the provider may have got", () =>
    Effect.gen(function* () {
      const waits: Array<UnsentRetry> = [];
      const unknown = clientOf([
        { events: [], failure: OAuthHarnessError.fromCode("transport_unavailable") },
      ]);
      expect(
        subscriptionFailure(
          yield* Effect.flip(streamed(unknown.client, ProviderRetryOutcome.Retry(), waits)),
        ),
      ).toEqual(failed(reasons.RequestOutcomeUnknown.make({})));
      const afterOutput = clientOf([
        { events: [NormalizedStreamEvent.text({ text: "partial" })], failure: notSent },
      ]);
      yield* Effect.flip(streamed(afterOutput.client, ProviderRetryOutcome.Retry(), waits));
      expect(waits).toEqual([]);
      expect([unknown.sent(), afterOutput.sent()]).toEqual([1, 1]);
    }),
  );

  it.effect("fails with the original failure when the wait allows no retry", () =>
    Effect.gen(function* () {
      const waits: Array<UnsentRetry> = [];
      const { client, sent } = clientOf([{ events: [], failure: notSent }]);
      expect(
        subscriptionFailure(
          yield* Effect.flip(streamed(client, ProviderRetryOutcome.Exhausted(), waits)),
        ),
      ).toEqual(failed(reasons.RequestNotSent.make({ stage: "dns" })));
      expect(waits).toHaveLength(1);
      expect(sent()).toBe(1);
    }),
  );
});
