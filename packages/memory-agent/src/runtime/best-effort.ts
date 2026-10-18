import { Effect } from "effect";

/**
 * Ends a best-effort step whose expected failure changes nothing for its owner, such as a cleanup
 * that a later step or the process exit makes moot. The failure is logged by its tag only: its
 * cause can hold paths, command output or provider text. Defects and interruptions pass through.
 */
export const ignoreLogged =
  (message: string, annotations: Readonly<Record<string, string>> = {}) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logDebug(message, { ...annotations, error: error._tag })),
    );
