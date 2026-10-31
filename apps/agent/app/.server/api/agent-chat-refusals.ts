import { Effect, Predicate } from "effect";

/**
 * `AgentChat` refuses with what the page reads: a code, or a blocked change. Its other failures
 * are errors; they become defects, which the server reports and answers 500.
 */
export const refusalsOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (failure): failure is Extract<E, Error> => Predicate.isError(failure),
    (failure) => Effect.die(failure),
  );
