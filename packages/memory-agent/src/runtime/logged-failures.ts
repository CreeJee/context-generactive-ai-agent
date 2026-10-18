import { Cause, Effect, Option, Schema } from "effect";

/**
 * Helpers for expected failures an owner logs instead of propagating. Each one logs a failure by
 * its tag only: its cause can hold paths, SQL, command output or provider text. Interruptions always
 * pass through.
 */

type Annotations = Readonly<Record<string, string>>;

const tagged = (annotations: Annotations, error: { readonly _tag: string }) => ({
  ...annotations,
  error: error._tag,
});

/** Logs an expected failure by its tag only, for a step whose failure ends nothing else. */
export const logFailure =
  (message: string, annotations: Annotations = {}) =>
  <E extends { readonly _tag: string }>(error: E) =>
    Effect.logWarning(message, tagged(annotations, error));

/**
 * Answers an expected failure the caller can do without with `fallback`. Defects pass through.
 */
export const fallbackLogged =
  <B>(message: string, fallback: () => B) =>
  <A, E extends { readonly _tag: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | B, never, R> =>
    Effect.catch(effect, (error) => Effect.as(logFailure(message)(error), fallback()));

/**
 * Ends a best-effort step whose expected failure changes nothing for its owner, such as a cleanup
 * that a later step or the process exit makes moot. It logs at debug level; defects pass through.
 */
export const ignoreLogged =
  (message: string, annotations: Annotations = {}) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logDebug(message, tagged(annotations, error))),
    );

/**
 * Logs a defect by the `Defect` tag only. Every defect an owner records instead of letting it end
 * the process goes through here.
 */
export const logDefect =
  (message: string, annotations: Annotations = {}) =>
  (_cause: Cause.Cause<unknown>) =>
    Effect.logError(message, { ...annotations, error: "Defect" });

const decodeTagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));
const decodeReasonTag = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Schema.Struct({ _tag: Schema.String }) }),
);

/**
 * A cause as its failures' tags, for text a person or model reads and for logs. A tagged reason,
 * such as a platform error's `PermissionDenied`, is named too; messages never are.
 */
export const failureTags = (cause: Cause.Cause<unknown>) => {
  const tags = cause.reasons.map((reason) => {
    switch (reason._tag) {
      case "Fail":
        return Option.match(decodeTagged(reason.error), {
          onNone: () => "Failure",
          onSome: ({ _tag }) =>
            Option.match(decodeReasonTag(reason.error), {
              onNone: () => _tag,
              onSome: (failure) => `${_tag}:${failure.reason._tag}`,
            }),
        });
      case "Die":
        return "Defect";
      case "Interrupt":
        return "Interrupted";
    }
  });
  return [...new Set(tags)].join(",");
};
