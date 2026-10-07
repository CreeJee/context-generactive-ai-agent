import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { execFile } from "node:child_process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { dirname } from "node:path";
import { Effect, HashSet, Schema } from "effect";
import { findExecutable, helperEnvironment } from "../runtime/host.ts";

/** Git runs with its own folder and the system folders on its search path, and nothing else. */
export const gitEnvironment = (git: string) => helperEnvironment([dirname(git)], { user: false });

const noFileMatched = Schema.is(Schema.Struct({ code: Schema.Literal(1) }));

/** Only ASCII case folding is the same in `git grep -i` and JavaScript. */
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * Project-relative files below `directory` whose content contains `query`, from `git grep` over
 * tracked and untracked (not ignored) files as they are on disk. Null when Git cannot answer
 * (not a work tree, git missing, or a case-insensitive query with non-ASCII letters), so the caller
 * searches every file instead. Lines are matched afterwards by the caller; this only narrows files.
 */
export const gitGrepFiles: {
  (
    directory: string,
    query: string,
    caseSensitive: boolean,
  ): (root: string) => ReturnType<typeof gitGrepFilesBody>;
} & typeof gitGrepFilesBody = EffectFunction.dual(4, gitGrepFilesBody);
function gitGrepFilesBody(
  root: string,
  directory: string,
  query: string,
  caseSensitive: boolean,
): Promise<HashSet.HashSet<string> | null> {
  return Effect.runPromise(gitGrepFilesEffect({ root, directory, query, caseSensitive }));
}

export const gitGrepFilesEffect = (options: {
  readonly root: string;
  readonly directory: string;
  readonly query: string;
  readonly caseSensitive: boolean;
}): Effect.Effect<HashSet.HashSet<string> | null> =>
  Effect.suspend(() => {
    const { root, directory, query, caseSensitive } = options;
    if (query.includes("\n") || (!caseSensitive && !isAscii(query))) return Effect.succeed(null);
    const git = findExecutable("git");
    if (!isTruthy(git)) return Effect.succeed(null);
    const args = [
      "grep",
      "--untracked",
      "--no-color",
      "-z",
      "-l",
      "-F",
      ...(caseSensitive ? [] : ["-i"]),
      "-e",
      query,
      "--",
      directory,
    ];
    return Effect.callback<HashSet.HashSet<string> | null>((resume) => {
      const child = execFile(
        git,
        args,
        {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          env: { ...gitEnvironment(git), LANG: "C", GIT_PAGER: "cat" },
        },
        (error, stdout) => {
          if (error === null)
            resume(Effect.succeed(HashSet.fromIterable(stdout.split("\0").filter(Boolean))));
          else resume(Effect.succeed(noFileMatched(error) ? HashSet.empty<string>() : null));
        },
      );
      return Effect.sync(() => {
        child.kill();
      });
    });
  });
