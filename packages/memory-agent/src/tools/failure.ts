import { tagOfUnknown } from "../runtime/failure-tag.ts";
import { Function as EffectFunction } from "effect";
import { Cause, Effect, HashMap, Option, Predicate, Schema } from "effect";
import { PathRejected } from "../files/paths.ts";
import { TextFileRejected, TextFileIoFailed, textFileRejectedReasonName } from "../files/text.ts";
import { optionalProperty } from "../optional-property.ts";

const refusalHints = HashMap.fromIterable<string, string>([
  [
    "invalid_path",
    "Project file tools take relative paths with / separators and no . or .. segments; outside tools take absolute paths.",
  ],
  ["credential", "Credential files are never read or changed, even with approval."],
  ["git_internal", "Files inside .git are not changed directly; run git through a sh skill."],
  ["inside_project", "The path is inside the project; use the project file tools instead."],
  [
    "outside_tool_root",
    "This run's tools are limited to its own card worktree; other worktrees and the user's checkout are refused.",
  ],
  ["symlink", "Links are not followed; use the real path."],
  ["hard_link", "Hard-linked files are not read or changed."],
  ["not_found", "Nothing exists at that path."],
  ["not_file", "The path is not a regular file."],
  ["not_directory", "The path is not a directory."],
  ["too_large", "Files over 2 MiB are not read by the file tools."],
  ["binary", "The file contains NUL bytes and is not text."],
  ["invalid_utf8", "The file is not valid UTF-8 text."],
  ["changed", "The file changed since it was read. Read it again before changing it."],
  ["exists", "A file already exists there. Read it and pass its sha256 to replace it."],
]);

/**
 * What the model reads for a failed tool call: a code, the failure's own tag, and the tool's
 * text, redacted, so the model can correct a path or an argument and try again.
 */
export const ToolFailureResult = Schema.Struct({
  error: Schema.String,
  cause: Schema.String,
  detail: Schema.String,
});
export type ToolFailureResult = typeof ToolFailureResult.Type;

/**
 * A tool call failed. `code` is the reason (`not_found`, `io_error`, …), `tag` the failure's tag;
 * the message keeps the `code: detail` form people and memory read.
 */
export class ToolFailed extends Schema.TaggedError<ToolFailed, { readonly brand: unique symbol }>()(
  "ToolFailed",
  {
    code: Schema.String,
    tag: Schema.String,
    detail: Schema.String,
    /** The tool refused before it changed anything, so the call had no effect. */
    refused: Schema.optionalKey(Schema.Literal(true)),
  },
) {
  override get message() {
    return `${this.code}: ${this.detail}`;
  }
}

/** The result a failed tool gives the model, in place of `{ error: message }`. */
export const failureResult = (failed: ToolFailed): ToolFailureResult => ({
  error: failed.code,
  cause: failed.tag,
  detail: failed.detail,
});

/** The same failure with `detail` in place of its text. */
export const withDetail: {
  (detail: string): (failed: ToolFailed) => ToolFailed;
  (failed: ToolFailed, detail: string): ToolFailed;
} = EffectFunction.dual(2, (failed: ToolFailed, detail: string) =>
  ToolFailed.make({
    code: failed.code,
    tag: failed.tag,
    detail,
    ...optionalProperty("refused", failed.refused),
  }),
);

/** The failure's tag, or its class name when it has none (a plain `Error`, an SDK's error). */
export const errorTag = (error: Error) => Option.getOrElse(tagOfUnknown(error), () => error.name);

const toolAuthored = /^([a-z_]+): ([\s\S]*)$/;
const isToolFailed = Schema.is(ToolFailed);

/**
 * Any tool error as a {@link ToolFailed}. Tool-authored messages already follow the
 * `code: detail` form; anything else is `tool_failed` with its message as the detail.
 */
export const toolFailedOf = (error: Error): ToolFailed =>
  Option.liftPredicate(error, isToolFailed).pipe(
    Option.getOrElse(() => {
      const authored = toolAuthored.exec(error.message);
      return ToolFailed.make({
        code: authored?.[1] ?? "tool_failed",
        tag: errorTag(error),
        detail: authored?.[2] ?? error.message,
      });
    }),
  );

/** A Node.js system error (`ENOENT`, `EACCES`, …). Only its code is kept for the model. */
export const SystemError = Schema.Struct({ code: Schema.String });
const decodeSystemError = Schema.decodeUnknownOption(SystemError);

/**
 * Turns a failure into what the model sees: its reason, its tag and `path. hint`. Host errors
 * keep only their code, so absolute paths and system messages do not leak into the conversation.
 */
export const toolFailure: {
  (path: string): (error: Error) => ReturnType<typeof toolFailureBody>;
} & typeof toolFailureBody = EffectFunction.dual(2, toolFailureBody);
function toolFailureBody(error: Error, path: string): ToolFailed {
  const tag = errorTag(error);
  const reason = Schema.is(PathRejected)(error)
    ? error.reason
    : Schema.is(TextFileRejected)(error)
      ? textFileRejectedReasonName(error.reason)
      : null;
  const ioError = (code: string) =>
    ToolFailed.make({ code: "io_error", tag, detail: `${path} (${code})` });
  // Already what the model reads. Its `code` field would otherwise pass for a system error's.
  return Option.liftPredicate(error, isToolFailed).pipe(
    Option.orElse(() =>
      Option.map(Option.fromNullishOr(reason), (code) =>
        ToolFailed.make({
          code,
          tag,
          detail: `${path}. ${Option.getOrUndefined(HashMap.get(refusalHints, code)) ?? ""}`.trim(),
        }),
      ),
    ),
    Option.orElse(() =>
      Option.map(Option.liftPredicate(error, Schema.is(TextFileIoFailed)), (failed) =>
        ioError(failed.reason.code),
      ),
    ),
    Option.orElse(() => Option.map(decodeSystemError(error), (system) => ioError(system.code))),
    // Tool-authored messages already follow the `reason: detail` form.
    Option.orElse(() =>
      Option.map(
        Option.liftPredicate(error, (candidate) => toolAuthored.test(candidate.message)),
        toolFailedOf,
      ),
    ),
    Option.getOrElse(() => ioError("unknown")),
  );
}

/** Keep model-facing path/error redaction at the SDK edge, including native callback exceptions. */
export const guardedEffect: {
  <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): (path: string) => ReturnType<typeof guardedEffectBody<A, E, R>>;
} & typeof guardedEffectBody = EffectFunction.dual(2, guardedEffectBody);
function guardedEffectBody<A, E, R>(path: string, program: Effect.Effect<A, E, R>) {
  return caught(path, program, () => false);
}

const isFileIoFailure = Schema.is(TextFileIoFailed);

/**
 * A failure of a file change that only reads and checks before its file operations. Those report
 * their failures as {@link TextFileIoFailed}; anything else, such as a rejected path, a changed
 * file or text that does not occur, came from a check, so nothing was changed. A defect may have
 * come from anywhere.
 */
const isRefusal = (error: Error, cause: Cause.Cause<unknown>) =>
  !isFileIoFailure(error) && !Cause.hasDies(cause);

/**
 * {@link guardedEffect} for a file change whose only writes are file operations (the file tools'
 * create, replace and delete). Its refusals are marked as changing nothing.
 */
export const guardedChange: {
  <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): (path: string) => ReturnType<typeof guardedChangeBody<A, E, R>>;
} & typeof guardedChangeBody = EffectFunction.dual(2, guardedChangeBody);
function guardedChangeBody<A, E, R>(path: string, program: Effect.Effect<A, E, R>) {
  return caught(path, program, isRefusal);
}

function caught<A, E, R>(
  path: string,
  program: Effect.Effect<A, E, R>,
  changedNothing: (error: Error, cause: Cause.Cause<unknown>) => boolean,
) {
  return program.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | Cause.UnknownError> => {
      const failure = Cause.squash(cause);
      const found = failure instanceof Cause.UnknownError ? failure.cause : failure;
      // A thrown non-Error carries nothing the model may see.
      const error = Predicate.isError(found) ? found : new Error("unknown");
      const failed = toolFailure(error, path);
      return Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.fail(
            new Cause.UnknownError(
              changedNothing(error, cause)
                ? ToolFailed.make({
                    code: failed.code,
                    tag: failed.tag,
                    detail: failed.detail,
                    refused: true,
                  })
                : failed,
            ),
          );
    }),
  );
}
