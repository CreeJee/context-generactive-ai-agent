import { Effect } from "effect";

/**
 * Answers an expected failure the caller can do without with `fallback`. The failure is logged by
 * its tag only: its cause can hold paths, SQL, command output or provider text. Defects and
 * interruptions pass through.
 */
export const fallbackLogged =
  <B>(message: string, fallback: () => B) =>
  <A, E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | B, never, R> =>
    Effect.catch(effect, (error) =>
      Effect.as(Effect.logWarning(message, { error: error._tag }), fallback()),
    );

/** Logs an expected failure by its tag only, for a step whose failure ends nothing else. */
export const logFailure =
  (message: string) =>
  <E extends { readonly _tag: string }>(error: E) =>
    Effect.logWarning(message, { error: error._tag });
