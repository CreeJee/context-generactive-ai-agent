import { Effect } from "effect";

/**
 * Ends a background kanban step whose expected failure a later look takes up again. The failure is
 * logged by its tag only: its cause can hold paths, command output or provider text. A defect is
 * logged the same way and stays in the step's exit; an interruption passes through.
 */
export const stopLogged =
  (message: string, annotations: Readonly<Record<string, string>>) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.as(Effect.logWarning(message, { ...annotations, error: error._tag }), undefined),
      ),
      Effect.tapDefect(() => Effect.logError(message, { ...annotations, error: "Defect" })),
    );
