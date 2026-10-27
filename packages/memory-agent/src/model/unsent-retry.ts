import { Clock, Effect, Function as EffectFunction, Option, Ref, Schema, Stream } from "effect";
import { AiError, type LanguageModel } from "effect/ai";
import { ProviderRetryOutcome, type ProviderRetryStage } from "../workflow/provider-retry.ts";
import {
  SubscriptionStreamFailed,
  SubscriptionStreamFailedReason,
  subscriptionFailure,
} from "./subscription.ts";

/** One wait before a request is sent again: its order in the run and when the first send failed. */
export interface UnsentRetry {
  readonly retry: number;
  readonly stage: ProviderRetryStage;
  readonly firstFailedAt: number;
}

/**
 * The stage a model failure stopped at when it is certain the provider never got the request.
 * Every other failure may have reached the provider.
 */
const unsentStage = <E>(error: E): Option.Option<ProviderRetryStage> =>
  Option.liftPredicate(error, AiError.isAiError).pipe(
    Option.flatMap(subscriptionFailure),
    Option.filter(Schema.is(SubscriptionStreamFailed)),
    Option.flatMap(({ reason }) =>
      Option.map(
        Option.liftPredicate(reason, SubscriptionStreamFailedReason.guards.RequestNotSent),
        ({ stage }) => stage,
      ),
    ),
  );

/**
 * A Goal run's model that sends a request again when the provider never got it (decisions.md
 * "승인된 Plan의 서버 자동 진행 (2026-10-02)", 2026-10-13): only while no part of the response has
 * arrived, after `wait` lets it. A retry the wait does not allow fails with the original failure.
 */
export const unsentRetried: {
  (
    wait: (retry: UnsentRetry) => Effect.Effect<ProviderRetryOutcome>,
  ): (model: LanguageModel.LanguageModel) => LanguageModel.LanguageModel;
  (
    model: LanguageModel.LanguageModel,
    wait: (retry: UnsentRetry) => Effect.Effect<ProviderRetryOutcome>,
  ): LanguageModel.LanguageModel;
} = EffectFunction.dual(2, unsentRetriedBody);
function unsentRetriedBody(
  model: LanguageModel.LanguageModel,
  wait: (retry: UnsentRetry) => Effect.Effect<ProviderRetryOutcome>,
): LanguageModel.LanguageModel {
  const attempt = <A, E, R>(
    open: () => Stream.Stream<A, E, R>,
    retry: number,
    firstFailedAt: Option.Option<number>,
  ): Stream.Stream<A, E, R> =>
    Stream.unwrap(
      Effect.map(Ref.make(false), (received) =>
        open().pipe(
          Stream.tap(() => Ref.set(received, true)),
          Stream.catch((error) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const stage = unsentStage(error);
                if (Option.isNone(stage) || (yield* Ref.get(received))) return Stream.fail(error);
                const failedAt = yield* Option.match(firstFailedAt, {
                  onNone: () => Clock.currentTimeMillis,
                  onSome: Effect.succeed,
                });
                const outcome = yield* wait({
                  retry: retry + 1,
                  stage: stage.value,
                  firstFailedAt: failedAt,
                });
                return ProviderRetryOutcome.$match(outcome, {
                  Retry: () => attempt(open, retry + 1, Option.some(failedAt)),
                  Exhausted: () => Stream.fail(error),
                  Cancelled: () => Stream.fail(error),
                });
              }),
            ),
          ),
        ),
      ),
    );
  return {
    ...model,
    // SAFETY: the parts pass through unchanged; a retry streams the same request's parts again.
    streamText: ((options: Parameters<LanguageModel.LanguageModel["streamText"]>[0]) =>
      attempt(
        () => model.streamText(options),
        0,
        Option.none(),
      )) as LanguageModel.LanguageModel["streamText"],
  };
}
