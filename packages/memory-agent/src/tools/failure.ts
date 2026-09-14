import { Either, Schema } from "effect";
import { PathRejected } from "../files/paths.ts";
import { TextFileRejected } from "../files/text.ts";

const refusalHints = new Map<string, string>([
  [
    "invalid_path",
    "Project file tools take relative paths with / separators and no . or .. segments; outside tools take absolute paths.",
  ],
  ["credential", "Credential files are never read or changed, even with approval."],
  ["git_internal", "Files inside .git are not changed directly; run git through the shell."],
  ["inside_project", "The path is inside the project; use the project file tools instead."],
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
 * Turns a failure into the message the model sees, `reason: path. hint`. Host errors keep only
 * their code, so absolute paths and system messages do not leak into the conversation.
 */
export function toolFailure(error: Error, path: string): Error {
  if (error instanceof PathRejected || error instanceof TextFileRejected)
    return new Error(`${error.reason}: ${path}. ${refusalHints.get(error.reason) ?? ""}`.trim());
  // Tool-authored messages already follow the `reason: detail` form.
  if (/^[a-z_]+: /.test(error.message) && !("code" in error)) return error;
  const code = "code" in error && Schema.is(Schema.String)(error.code) ? error.code : "unknown";
  return new Error(`io_error: ${path} (${code})`);
}

/** Runs one tool operation, rethrowing any failure as a model-facing message. */
export async function guarded<A>(path: string, operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch (error) {
    throw toolFailure(error instanceof Error ? error : new Error(String(error)), path);
  }
}

/** Unwraps a path resolution inside {@link guarded}, throwing the rejection. */
export const orThrow = <A>(result: Either.Either<A, PathRejected>) =>
  Either.getOrElse(result, (rejection) => {
    throw rejection;
  });
