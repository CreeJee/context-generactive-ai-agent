import { Cause, Clock, Effect, Match, Option, Result, Schema } from "effect";
import { SubscriptionStreamFailed } from "../providers/subscription-adapter.ts";
import { nativePromise } from "../runtime/native-effect.ts";
import type { ProviderRetries, ProviderRetryStage } from "../workflow/provider-retry.ts";

/** Owner-side waits between retries of one run's provider requests. */
export interface ProviderRetryOwner {
  readonly wait: (
    request: {
      readonly retry: number;
      readonly stage: ProviderRetryStage;
      readonly firstFailedAt: number;
    },
    signal: AbortSignal,
  ) => ReturnType<ProviderRetries["Service"]["wait"]>;
}

/** One owner model stream. `open` starts the same provider request again. */
export interface OwnerModelStream {
  // The native SDK adapter iterator yields untyped stream chunks.
  // oxlint-disable-next-line typescript/no-explicit-any
  iterator: AsyncIterator<any>;
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly open: () => AsyncIterator<any>;
  /** A chunk other than the adapter's own RUN_STARTED reached the worker. */
  delivered: boolean;
}

/**
 * The stage of a provider failure that is certain to have happened before the request reached
 * the provider. Every other failure may have been seen by the provider and is never retried.
 */
export const requestNotSentStage = (
  error: SubscriptionStreamFailed,
): Option.Option<ProviderRetryStage> =>
  Match.valueTags(error.reason, {
    RequestNotSent: ({ stage }) => Option.some(stage),
    ProviderRejected: () => Option.none(),
    ProviderStatusRejected: () => Option.none(),
    ResponseInterrupted: () => Option.none(),
    RequestOutcomeUnknown: () => Option.none(),
    InvalidReasoning: () => Option.none(),
    InvalidToolCall: () => Option.none(),
    InvalidBlockEnd: () => Option.none(),
    IncompleteBlocks: () => Option.none(),
    EncryptedReasoningLimit: () => Option.none(),
  });

/**
 * Pulls the next chunk of an owner model stream. When the provider request was never sent and
 * nothing but the adapter's RUN_STARTED reached the worker, waits durably and sends the same
 * request again on a fresh stream, skipping that stream's RUN_STARTED. Each pull passes `admit`
 * (the model gate); the wait between pulls holds no model permit. Any other failure, exhaustion
 * or cancellation fails with the original provider failure. A failed durable wait retains its
 * typed owner failure so a storage/admission error is not reported as cancellation.
 */
export const pullModelChunk = Effect.fnUntraced(function* <E>(
  stream: OwnerModelStream,
  retries: ProviderRetryOwner | undefined,
  signal: AbortSignal,
  admit: <A>(
    pull: Effect.Effect<A, Cause.UnknownError>,
  ) => Effect.Effect<A, Cause.UnknownError | E>,
) {
  let retry = 0;
  let firstFailedAt: number | undefined;
  let skipStart = false;
  while (true) {
    const pulled = yield* admit(nativePromise(() => Promise.resolve(stream.iterator.next()))).pipe(
      Effect.result,
    );
    if (Result.isSuccess(pulled)) {
      const next = pulled.success;
      if (next.done !== true && next.value?.type === "RUN_STARTED") {
        if (skipStart) {
          skipStart = false;
          continue;
        }
      } else if (next.done !== true) stream.delivered = true;
      return next;
    }
    const failure = pulled.failure;
    // Native adapter failures cross the iterator boundary as the thrown provider error.
    const stage =
      Cause.isUnknownError(failure) && Schema.is(SubscriptionStreamFailed)(failure.cause)
        ? requestNotSentStage(failure.cause)
        : Option.none();
    if (retries === undefined || stream.delivered || Option.isNone(stage))
      return yield* Effect.fail(failure);
    retry += 1;
    firstFailedAt ??= yield* Clock.currentTimeMillis;
    const outcome = yield* retries.wait({ retry, stage: stage.value, firstFailedAt }, signal);
    yield* Match.valueTags(outcome, {
      Retry: () =>
        Effect.sync(() => {
          stream.iterator = stream.open();
          skipStart = true;
        }),
      Exhausted: () => Effect.fail(failure),
      Cancelled: () => Effect.fail(failure),
    });
  }
});
