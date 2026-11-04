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

/** A tag with the failure's tagged reason, when it names one: `SqlError:LockTimeoutError`. */
const withReason = <A>(tag: string, failure: A) =>
  Option.match(reasonTagOf(failure), {
    onNone: () => tag,
    onSome: (reason) => `${tag}:${reason}`,
  });

/** How logs name a typed failure: its tag, with its tagged reason when it names one. */
export const failureNameOf = <E extends { readonly _tag: string }>(error: E) =>
  withReason(tagOf(error), error);

/** How logs name a value that carries a tag, such as a cause or a library's error. */
export const failureNameOfUnknown = <A>(value: A) =>
  Option.map(tagOfUnknown(value), (tag) => withReason(tag, value));

const causeOf = Schema.decodeUnknownOption(Schema.Struct({ cause: Schema.Unknown }));
const reasonOf = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.Unknown }));

/**
 * What caused a failure. An Effect error that names a tagged reason, such as `SqlError`, gives that
 * reason as its `cause`; the reason is already in the failure's name, so the chain goes on from the
 * reason's own cause. A failure whose cause is not its reason goes on from that cause.
 */
const causeAfter = <A>(failure: A) =>
  Option.flatMap(causeOf(failure), (caused) =>
    Option.exists(reasonOf(failure), ({ reason }) => reason === caused.cause)
      ? causeOf(caused.cause)
      : Option.some(caused),
  );

/** A system error code such as `ECONNRESET` or undici's `UND_ERR_CONNECT_TIMEOUT`; never text. */
const ErrorCode = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{1,63}$/));
const decodeErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: ErrorCode }));

/** A failure and what caused it, down its `cause` chain: each value once, at most eight. */
const causeChain = <A>(failure: A) =>
  EffectArray.unfold(
    { current: Option.some<unknown>(failure), seen: EffectArray.empty<unknown>() },
    ({ current, seen }) =>
      Option.filter(current, (value) => !seen.includes(value) && seen.length < 8).pipe(
        Option.map(
          (value) =>
            [
              value,
              { current: Option.map(causeOf(value), ({ cause }) => cause), seen: [...seen, value] },
            ] as const,
        ),
      ),
  );

/**
 * The system error codes down a failure's `cause` chain, outermost first, such as a fetch that
 * could not connect: `["UND_ERR_CONNECT_TIMEOUT"]`. A tag says only that a request failed; the code
 * says how.
 */
export const errorCodesOf = <A>(failure: A) =>
  // The decoder's second parameter is its options: `map` would pass the index there.
  EffectArray.getSomes(causeChain(failure).map((value) => decodeErrorCode(value))).map(
    ({ code }) => code,
  );

/**
 * A failure's name with the error codes down its cause chain, when there are any:
 * `AiError:NetworkError (UND_ERR_CONNECT_TIMEOUT)`.
 */
export const withErrorCodes: {
  <A>(failure: A): (name: string) => string;
  <A>(name: string, failure: A): string;
} = EffectFunction.dual(2, <A>(name: string, failure: A) =>
  EffectArray.match(errorCodesOf(failure), {
    onEmpty: () => name,
    onNonEmpty: (codes) => `${name} (${codes.join(" <- ")})`,
  }),
);

/**
 * The tags down a failure's `cause` chain, each with its tagged `reason`, such as
 * `["VectorIndexError", "SqlError:LockTimeoutError"]`. The failure's own reason is in its name, so
 * the chain starts after it, and it stops at the first cause without a tag.
 */
export const causeTagsOf = <E extends { readonly _tag: string }>(error: E) =>
  EffectArray.unfold(causeAfter(error), (caused) =>
    Option.flatMap(caused, ({ cause }) =>
      Option.map(failureNameOfUnknown(cause), (name) => [name, causeAfter(cause)] as const),
    ),
  );
