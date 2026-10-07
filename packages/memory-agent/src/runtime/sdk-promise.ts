import { Effect, Function, Schema } from "effect";

export class SdkRequestFailed extends Schema.TaggedError<SdkRequestFailed>()("SdkRequestFailed", {
  cause: Schema.Defect(),
}) {}

/** SDKs that require an AbortController still follow the calling fiber's cancellation. */
function invoke<A>(options: {
  readonly signal: AbortSignal;
  readonly controller?: AbortController;
  readonly execute: (controller: AbortController) => Promise<A>;
}): Promise<A> {
  const controller = options.controller ?? new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    return options
      .execute(controller)
      .finally(() => options.signal.removeEventListener("abort", abort));
  } catch (cause) {
    options.signal.removeEventListener("abort", abort);
    throw cause;
  }
}

export const sdkPromise = <A>(execute: (controller: AbortController) => Promise<A>) =>
  Effect.tryPromise({
    try: (signal) => invoke({ signal, execute }),
    catch: (cause) => SdkRequestFailed.make({ cause }),
  });

/** Interrupt a pending SDK operation without replacing the run's existing controller. */
export const sdkPromiseWithController: {
  (
    controller: AbortController,
  ): <A>(execute: () => Promise<A>) => Effect.Effect<A, SdkRequestFailed>;
  <A>(execute: () => Promise<A>, controller: AbortController): Effect.Effect<A, SdkRequestFailed>;
} = Function.dual(2, <A>(execute: () => Promise<A>, controller: AbortController) =>
  Effect.tryPromise({
    try: (signal) => invoke({ signal, controller, execute }),
    catch: (cause) => SdkRequestFailed.make({ cause }),
  }),
);
