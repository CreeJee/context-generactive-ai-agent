import { Array as EffectArray, Function as EffectFunction, Option, Schema } from "effect";

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

const causeOf = Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.Unknown }));
const reasonOf = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.Unknown }));

/**
 * What caused a cause in the chain. An Effect error that names a tagged reason, such as `SqlError`,
 * gives that reason as its `cause`; the reason is already named with its error, so the chain goes on
 * from the reason's own cause.
 */
const causeAfter = <A>(cause: A) =>
  Option.match(reasonTagOf(cause), {
    onNone: () => causeOf(cause),
    onSome: () => Option.flatMap(reasonOf(cause), ({ reason }) => causeOf(reason)),
  });

/**
 * The tags down a failure's `cause` chain, each with its tagged `reason`, such as
 * `["VectorIndexError", "SqlError:LockTimeoutError"]`. The chain stops at the first cause without a
 * tag.
 */
export const causeTagsOf = <E extends { readonly _tag: string }>(error: E) =>
  EffectArray.unfold(causeOf(error), (caused) =>
    Option.flatMap(caused, ({ cause }) =>
      Option.map(
        tagOfUnknown(cause),
        (tag) =>
          [
            Option.match(reasonTagOf(cause), {
              onNone: () => tag,
              onSome: (reason) => `${tag}:${reason}`,
            }),
            causeAfter(cause),
          ] as const,
      ),
    ),
  );
