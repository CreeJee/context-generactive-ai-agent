import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { execFile } from "node:child_process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { lstat, readdir } from "node:fs/promises";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { MutableHashMap, Option, Effect, HashSet, Array as EffectArray } from "effect";
import { findExecutable } from "../runtime/host.ts";
import { gitEnvironment } from "./git-grep.ts";
import { isCredentialPath } from "./paths.ts";

const run = promisify(execFile);

/** File checks run at once when listing a Git work tree. */
const statConcurrency = 64;

/** Directories skipped when walking a project that is not a Git work tree. */
const walkSkips = HashSet.fromIterable([".git", "node_modules"]);

/** Files a walk collects before it stops and reports itself truncated. */
export const walkLimit = 50_000;

export interface FileListing {
  /** Sorted file paths: project-relative for project listings, absolute for outside listings. */
  readonly paths: readonly string[];
  /** `git` when Git decided (tracked plus untracked, honouring ignore rules), else `walk`. */
  readonly source: "git" | "walk";
  /** Files and directories left out because they look like credentials. */
  readonly excluded: number;
  /** True when a walk stopped at {@link walkLimit} files. */
  readonly truncated: boolean;
}

// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const gitFiles = Effect.fn("FileListing.gitFiles")(function* (root: string, directory: string) {
  const git = findExecutable("git");
  if (!isTruthy(git)) return null;
  return yield* Effect.tryPromise((signal) =>
    run(git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", directory], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: gitEnvironment(git),
      signal,
    }),
  ).pipe(
    Effect.map(({ stdout }) => stdout.split("\0").filter(Boolean)),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Regular files below `directory` (relative to `base`), not following links and not descending
 * into `.git`, `node_modules` or credential-looking directories. Directory names are judged as
 * `credentialPrefix` joined with the relative path: empty for a project, whose root may itself sit
 * under an unusual name, and the absolute base outside, where `~/.config` + `gh` must still match.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const walkFiles = Effect.fn("FileListing.walkFiles")(function* (
  base: string,
  directory: string,
  credentialPrefix: string,
) {
  const files: string[] = [];
  let excluded = 0;
  let truncated = false;
  const visit = (relative: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* Effect.tryPromise(() =>
        readdir(join(base, relative), { withFileTypes: true }),
      ).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (files.length >= walkLimit) {
          truncated = true;
          return;
        }
        const path = relative === "." ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (HashSet.has(walkSkips, entry.name)) continue;
          if (isCredentialPath(join(credentialPrefix, path))) excluded++;
          else yield* visit(path);
        } else if (entry.isFile()) files.push(path);
      }
    });
  yield* visit(directory);
  return { files, excluded, truncated };
});

/**
 * Every regular file below `directory` (project-relative, already validated), optionally filtered
 * by a glob relative to that directory. Symlinks, `.git` and credential-looking files are left out;
 * a tracked file deleted from disk is not listed.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const listProjectFiles: {
  (
    directory: string,
    glob: string | undefined,
  ): (root: string) => ReturnType<typeof listProjectFilesBody>;
} & typeof listProjectFilesBody = EffectFunction.dual(3, listProjectFilesBody);
export const listProjectFilesEffect = Effect.fn("FileListing.project")(function* (
  root: string,
  directory: string,
  glob: string | undefined,
) {
  const fromGit = yield* gitFiles(root, directory);
  const walked = isTruthy(fromGit) ? undefined : yield* walkFiles(root, directory, "");
  const prefix = directory === "." ? "" : `${directory}/`;
  let excluded = walked?.excluded ?? 0;
  const kept: string[] = [];
  for (const path of EffectArray.dedupe(fromGit ?? walked?.files ?? [])) {
    if (!path.startsWith(prefix)) continue;
    if (glob !== undefined && !posix.matchesGlob(path.slice(prefix.length), glob)) continue;
    if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) continue;
    if (isCredentialPath(path)) {
      excluded++;
      continue;
    }
    kept.push(path);
  }
  // A walk already saw regular files only. Git lists links and deleted files too, so check those,
  // many at a time.
  const paths = isTruthy(fromGit)
    ? (yield* Effect.forEach(
        kept,
        (path) =>
          Effect.tryPromise(() => lstat(join(root, path))).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.map((entry) => (entry?.isFile() === true ? path : null)),
          ),
        { concurrency: statConcurrency },
      )).filter((path) => path !== null)
    : kept;
  paths.sort();
  return {
    paths,
    source: isTruthy(fromGit) ? "git" : "walk",
    excluded,
    truncated: walked?.truncated ?? false,
  } satisfies FileListing;
});

function listProjectFilesBody(
  root: string,
  directory: string,
  glob: string | undefined,
): Promise<FileListing> {
  return Effect.runPromise(listProjectFilesEffect(root, directory, glob));
}

/**
 * Every regular file below an outside `directory` (canonical, already validated), as absolute
 * paths, optionally filtered by a glob relative to it. Never uses Git ignore rules: outside
 * listings show what is on disk, minus links, `.git`, `node_modules` and credentials.
 */
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const listOutsideFiles: {
  (glob: string | undefined): (directory: string) => ReturnType<typeof listOutsideFilesBody>;
} & typeof listOutsideFilesBody = EffectFunction.dual(2, listOutsideFilesBody);
export const listOutsideFilesEffect = Effect.fn("FileListing.outside")(function* (
  directory: string,
  glob: string | undefined,
) {
  const walked = yield* walkFiles(directory, ".", directory);
  let excluded = walked.excluded;
  const paths: string[] = [];
  for (const relative of walked.files) {
    if (glob !== undefined && !posix.matchesGlob(relative, glob)) continue;
    const absolute = join(directory, relative);
    if (isCredentialPath(absolute)) excluded++;
    else paths.push(absolute);
  }
  paths.sort();
  return { paths, source: "walk", excluded, truncated: walked.truncated } satisfies FileListing;
});

function listOutsideFilesBody(directory: string, glob: string | undefined): Promise<FileListing> {
  return Effect.runPromise(listOutsideFilesEffect(directory, glob));
}

export interface Snapshot extends FileListing {
  readonly id: string;
  readonly root: string;
  readonly directory: string;
  readonly glob: string | undefined;
}

/**
 * Recent listings, so paging through `list_files` or `search_files` walks one fixed set of files
 * instead of a tree that shifts between pages. Old snapshots are dropped first.
 */
export const createSnapshots = (capacity = 32) =>
  Effect.sync(() => {
    const entries = MutableHashMap.empty<string, Snapshot>();
    return {
      add(root: string, directory: string, glob: string | undefined, listing: FileListing) {
        const snapshot: Snapshot = { id: randomUUID(), root, directory, glob, ...listing };
        MutableHashMap.set(entries, snapshot.id, snapshot);
        for (const id of MutableHashMap.keys(entries)) {
          if (MutableHashMap.size(entries) <= capacity) break;
          MutableHashMap.remove(entries, id);
        }
        return snapshot;
      },

      /** A snapshot taken for this project root, or undefined when unknown or evicted. */
      get(id: string, root: string) {
        const snapshot = Option.getOrUndefined(MutableHashMap.get(entries, id));
        return snapshot?.root === root ? snapshot : undefined;
      },
    };
  });
