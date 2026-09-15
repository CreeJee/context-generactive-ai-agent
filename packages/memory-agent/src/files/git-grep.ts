import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { Schema } from "effect";
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
export function gitGrepFiles(
  root: string,
  directory: string,
  query: string,
  caseSensitive: boolean,
): Promise<ReadonlySet<string> | null> {
  if (query.includes("\n") || (!caseSensitive && !isAscii(query))) return Promise.resolve(null);
  const git = findExecutable("git");
  if (!git) return Promise.resolve(null);
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
  return new Promise((resolve) => {
    execFile(
      git,
      args,
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // A fixed environment: no user pager, config-driven external tools or locale surprises.
        env: { ...gitEnvironment(git), LANG: "C", GIT_PAGER: "cat" },
      },
      (error, stdout) => {
        if (!error) return resolve(new Set(stdout.split("\0").filter(Boolean)));
        // Exit status 1 means "no file matched"; anything else means Git could not answer.
        resolve(noFileMatched(error) ? new Set() : null);
      },
    );
  });
}
