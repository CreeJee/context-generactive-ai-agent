import { Cause, Effect, Exit } from "effect";

/** React Query and browser APIs own their Promise operations; Effects own sequencing and recovery. */
export const uiPromise = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new Cause.UnknownError(cause) });

export const uiFailure = <E>(cause: Cause.Cause<E>) => {
  const failure = Cause.squash(cause);
  return failure instanceof Cause.UnknownError ? failure.cause : failure;
};

/** Preserve API and browser error identity for callbacks consumed by React and React Query. */
export const runUiEffect = <A, E>(program: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(program).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => Promise.reject(uiFailure(cause)),
    }),
  );
