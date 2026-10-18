import { nativeFailure } from "../runtime/native-effect.ts";
import { Function as EffectFunction } from "effect";
import { Cause, Effect, Exit, HashMap, Result, Option, Predicate, Schema } from "effect";
import { PathRejected } from "../files/paths.ts";
import { TextFileRejected, TextFileIoFailed } from "../files/text.ts";

const refusalHints = HashMap.fromIterable<string, string>([
  [
    "invalid_path",
    "Project file tools take relative paths with / separators and no . or .. segments; outside tools take absolute paths.",
  ],
  ["credential", "Credential files are never read or changed, even with approval."],
  ["git_internal", "Files inside .git are not changed directly; run git through a shell skill."],
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

/** A Node.js system error (`ENOENT`, `EACCES`, …). Only its code is kept for the model. */
export const SystemError = Schema.Struct({ code: Schema.String });
const decodeSystemError = Schema.decodeUnknownOption(SystemError);

/**
 * Turns a failure into the message the model sees, `reason: path. hint`. Host errors keep only
 * their code, so absolute paths and system messages do not leak into the conversation.
 */
export const toolFailure: {
  (path: string): (error: Error) => ReturnType<typeof toolFailureBody>;
} & typeof toolFailureBody = EffectFunction.dual(2, toolFailureBody);
function toolFailureBody(error: Error, path: string): Error {
  const reason = Schema.is(PathRejected)(error)
    ? error.reason
    : Schema.is(TextFileRejected)(error)
      ? error.reason._tag
      : null;
  if (reason !== null)
    return new Error(
      `${reason}: ${path}. ${Option.getOrUndefined(HashMap.get(refusalHints, reason)) ?? ""}`.trim(),
    );
  if (Schema.is(TextFileIoFailed)(error))
    return new Error(`io_error: ${path} (${error.reason.code})`);
  const systemError = Option.getOrUndefined(decodeSystemError(error));
  if (systemError !== undefined) return new Error(`io_error: ${path} (${systemError.code})`);
  // Tool-authored messages already follow the `reason: detail` form.
  if (/^[a-z_]+: /.test(error.message)) return error;
  return new Error(`io_error: ${path} (unknown)`);
}

/** Runs one tool operation, rethrowing any failure as a model-facing message. */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const guarded: {
  <A, E = never>(
    operation: () => Promise<A> | Effect.Effect<A, E>,
    signal?: AbortSignal,
  ): (path: string) => Promise<A>;
} & typeof guardedBody = EffectFunction.dual(
  (args) => Schema.is(Schema.String)(args[0]),
  guardedBody,
);
function guardedBody<A, E = never>(
  path: string,
  operation: () => Promise<A> | Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const work = Effect.suspend<A, E | Cause.UnknownError, never>(() => {
    const result = operation();
    return Effect.isEffect(result) ? result : Effect.tryPromise(() => result);
  });
  return Effect.runPromiseExit(guardedEffect(path, work), { signal }).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => Promise.reject(nativeFailure(cause).cause),
    }),
  );
}

/** Keep model-facing path/error redaction at the SDK edge, including native callback exceptions. */
export const guardedEffect: {
  <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ): (path: string) => ReturnType<typeof guardedEffectBody<A, E, R>>;
} & typeof guardedEffectBody = EffectFunction.dual(2, guardedEffectBody);
function guardedEffectBody<A, E, R>(path: string, program: Effect.Effect<A, E, R>) {
  return program.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | Cause.UnknownError> => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      const error = failure instanceof Cause.UnknownError ? failure.cause : failure;
      return Effect.fail(
        new Cause.UnknownError(
          // A thrown non-Error carries nothing the model may see.
          toolFailure(Predicate.isError(error) ? error : new Error("unknown"), path),
        ),
      );
    }),
  );
}

/** Unwraps a path resolution inside {@link guarded}, throwing the rejection. */
export const orThrow = <A>(result: Result.Result<A, PathRejected>) =>
  Result.getOrElse(result, (rejection) => {
    throw rejection;
  });
