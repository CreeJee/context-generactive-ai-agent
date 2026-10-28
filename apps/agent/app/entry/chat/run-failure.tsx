import { Option, Schema } from "effect";
import {
  runFailureCodeOf,
  runFailureText,
  type RunFailureCode,
  type ShownFailure,
} from "memory-agent/definitions";
import { FailureDetails } from "../shared/failure-details";

const decodeErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

/**
 * A run's error as the page shows it: the chat client keeps the `RUN_ERROR` code on the error,
 * and its message (redacted by the server) becomes the folded detail. An error without a known
 * code, such as a dropped connection or a run saved by an older version, is a general failure.
 */
export const runFailureOf = (error: {
  readonly message: string;
}): ShownFailure<RunFailureCode> => ({
  code: runFailureCodeOf(Option.getOrUndefined(decodeErrorCode(error))?.code),
  detail: error.message,
});

/** A failed run's wording, with the run's own text folded under it. */
export function RunFailureText({ error }: { error: { readonly message: string } }) {
  const failure = runFailureOf(error);
  return (
    <>
      <p>{runFailureText[failure.code]}</p>
      <FailureDetails detail={failure.detail} />
    </>
  );
}
