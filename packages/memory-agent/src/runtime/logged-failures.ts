import {
  Array as EffectArray,
  Cause,
  Effect,
  Function as EffectFunction,
  Match,
  Option,
  Schema,
} from "effect";
import { DefectReporter } from "./defect-reporter.ts";
import { causeTagsOf, failureNameOf, failureNameOfUnknown } from "./failure-tag.ts";

/**
 * Helpers for expected failures an owner logs instead of propagating. Each one logs a failure by
 * its tag only: its cause can hold paths, SQL, command output or provider text. Interruptions always
 * pass through.
 */

type Annotations = Readonly<Record<string, string>>;

/**
 * A failure as log annotations: its name, and the names of what caused it, outermost first, when it
 * names a cause. A log that annotates a failure itself takes them from here.
 */
export const failureAnnotations = <E extends { readonly _tag: string }>(error: E) =>
  EffectArray.match(causeTagsOf(error), {
    onEmpty: () => ({ error: failureNameOf(error) }),
    onNonEmpty: (causes) => ({ error: failureNameOf(error), cause: causes.join(" < ") }),
  });

const tagged = <E extends { readonly _tag: string }>(annotations: Annotations, error: E) => ({
  ...annotations,
  ...failureAnnotations(error),
});

/** The data-first call names the message; the pipeable one gives only the annotations. */
const messageFirst = (args: IArguments) => Schema.is(Schema.String)(args[0]);

/** Logs an expected failure by its tag only, for a step whose failure ends nothing else. */
export const logFailure: {
  (annotations: Annotations): (message: string) => ReturnType<typeof logFailureBody>;
  (message: string): ReturnType<typeof logFailureBody>;
  (message: string, annotations: Annotations): ReturnType<typeof logFailureBody>;
} = EffectFunction.dual(messageFirst, logFailureBody);
function logFailureBody(message: string, annotations: Annotations = {}) {
  return <E extends { readonly _tag: string }>(error: E) =>
    Effect.logWarning(message, tagged(annotations, error));
}

/**
 * Answers an expected failure the caller can do without with `fallback`. Defects pass through.
 */
export const fallbackLogged: {
  <B>(fallback: () => B): (message: string) => WithFallback<B>;
} & typeof fallbackLoggedBody = EffectFunction.dual(2, fallbackLoggedBody);
function fallbackLoggedBody<B>(message: string, fallback: () => B): WithFallback<B> {
  return (effect) =>
    Effect.catch(effect, (error) => Effect.as(logFailure(message)(error), fallback()));
}
type WithFallback<B> = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A | B, never, R>;

/**
 * Ends a best-effort step whose expected failure changes nothing for its owner, such as a cleanup
 * that a later step or the process exit makes moot. It logs at debug level; defects pass through.
 */
export const ignoreLogged: {
  (annotations: Annotations): (message: string) => ReturnType<typeof ignoreLoggedBody>;
  (message: string): ReturnType<typeof ignoreLoggedBody>;
  (message: string, annotations: Annotations): ReturnType<typeof ignoreLoggedBody>;
} = EffectFunction.dual(messageFirst, ignoreLoggedBody);
function ignoreLoggedBody(message: string, annotations: Annotations = {}) {
  return <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logDebug(message, tagged(annotations, error))),
    );
}

/**
 * Logs a defect by its failures' tags only and hands it to the defect reporter: a typed failure the
 * owner could not answer by its tag and reason, a die as `Defect`. Every defect an owner records
 * instead of letting it end the process goes through here.
 */
export const logDefect: {
  (annotations: Annotations): (message: string) => ReturnType<typeof logDefectBody>;
  (message: string): ReturnType<typeof logDefectBody>;
  (message: string, annotations: Annotations): ReturnType<typeof logDefectBody>;
} = EffectFunction.dual(messageFirst, logDefectBody);
function logDefectBody(message: string, annotations: Annotations = {}) {
  return (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      yield* Effect.logError(message, { ...annotations, error: failureTags(cause) });
      yield* (yield* DefectReporter).report({ message, annotations, cause });
    });
}

/**
 * A cause as its failures' tags, for text a person or model reads and for logs. A tagged reason,
 * such as a platform error's `PermissionDenied`, is named too; messages never are.
 */
export const failureTags = (cause: Cause.Cause<unknown>) => {
  const tags = cause.reasons.map(
    Match.valueTags({
      Fail: ({ error }) => Option.getOrElse(failureNameOfUnknown(error), () => "Failure"),
      Die: () => "Defect",
      Interrupt: () => "Interrupted",
    }),
  );
  return [...new Set(tags)].join(",");
};
