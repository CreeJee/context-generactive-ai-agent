import { Cause, Context, Effect, Exit } from "effect";

export interface NativeRejection {
  readonly _tag: "NativeRejection";
  readonly cause: unknown;
}

/** Native SDK callbacks keep their original rejection values at the Promise boundary. */
export const nativeFailure = <E>(cause: Cause.Cause<E>): NativeRejection => {
  const failure = Cause.squash(cause);
  return {
    _tag: "NativeRejection",
    cause: failure instanceof Cause.UnknownError ? failure.cause : failure,
  };
};

/** Only wrap operations that actually belong to a Promise-based host or SDK. */
export const nativePromise = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) });

export const runNativeEffect = <A, E>(
  program: Effect.Effect<A, E>,
  options?: Effect.RunOptions,
): Promise<A> =>
  Effect.runPromiseExit(program, options).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => Promise.reject(nativeFailure(cause).cause),
    }),
  );

export const runNativeEffectWith =
  <R>(context: Context.Context<R>) =>
  <A, E>(program: Effect.Effect<A, E, R>, options?: Effect.RunOptions): Promise<A> =>
    runNativeEffect(program.pipe(Effect.provideContext(context)), options);
