import { Function as EffectFunction, Option, Schema } from "effect";

/**
 * The one place that reads a failure's tag. Logs, reports and stored summaries name an error by its
 * tag alone, since its cause can hold paths, SQL, command output or provider text; they take the
 * name from here instead of reading the error themselves.
 */

/** The tag of a typed failure. */
export const tagOf = <E extends { readonly _tag: string }>(error: E): string => error._tag;

const Tagged = Schema.Struct({ _tag: Schema.String });

/** The tag of a value that carries one: a typed error, a library's tagged error, a tagged defect. */
export const tagOfUnknown = EffectFunction.flow(
  Schema.decodeUnknownOption(Tagged),
  Option.map((tagged) => tagOf(tagged)),
);

/** The tag of a failure's tagged `reason`, such as a platform error's `PermissionDenied`. */
export const reasonTagOf = EffectFunction.flow(
  Schema.decodeUnknownOption(Schema.Struct({ reason: Tagged })),
  Option.map(({ reason }) => tagOf(reason)),
);
