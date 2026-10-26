import { nativeFailure } from "../runtime/native-effect.ts";
import { tagOfUnknown } from "../runtime/failure-tag.ts";
import { Function as EffectFunction } from "effect";
import { Cause, Context, Effect, Exit, HashMap, Result, Option, Predicate, Schema } from "effect";
import { type RunTrace } from "../runtime/run-trace.ts";
import { PathRejected } from "../files/paths.ts";
import { TextFileRejected, TextFileIoFailed, textFileRejectedReasonName } from "../files/text.ts";

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
 * Where the patched SDK (`patches/@tanstack__ai@1.0.0.patch`) finds the result a failed tool
 * gives the model, in place of `{ error: message }`.
 */
export const toolResultKey = Symbol.for("tanstack-ai.toolResult");

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
export class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", {
  code: Schema.String,
  tag: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `${this.code}: ${this.detail}`;
  }

  get [toolResultKey](): ToolFailureResult {
    return { error: this.code, cause: this.tag, detail: this.detail };
  }
}

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
  return guardedOn(Context.empty(), path, operation, signal);
}

/** `guarded` on a run's context, so the tool's spans join the run's trace. */
export const guardedWith =
  (caller: RunTrace) =>
  <A, E = never>(
    path: string,
    operation: () => Promise<A> | Effect.Effect<A, E>,
    signal?: AbortSignal,
  ): Promise<A> =>
    guardedOn(caller, path, operation, signal);

function guardedOn<A, E, R>(
  context: Context.Context<R>,
  path: string,
  operation: () => Promise<A> | Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const work = Effect.suspend<A, E | Cause.UnknownError, never>(() => {
    const result = operation();
    return Effect.isEffect(result) ? result : Effect.tryPromise(() => result);
  });
  return Effect.runPromiseExitWith(context)(guardedEffect(path, work), { signal }).then(
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
      const failure = Cause.squash(cause);
      const error = failure instanceof Cause.UnknownError ? failure.cause : failure;
      return Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.fail(
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
