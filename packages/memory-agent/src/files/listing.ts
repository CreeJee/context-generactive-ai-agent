import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isTruthy } from "../truthy.ts";
// Effect Path has no glob matcher; minimatch is what Node's `path.matchesGlob` runs.
import { minimatch } from "minimatch";
import { path as hostPath } from "../runtime/synchronous-path.ts";
import {
  Context,
  FileSystem,
  Crypto,
  Layer,
  Stream,
  Option,
  Effect,
  Ref,
  HashSet,
  Chunk,
  Array as EffectArray,
} from "effect";
import { findExecutable } from "../runtime/host.ts";
import { gitEnvironment, gitOutputText } from "./git-grep.ts";
import { isCredentialPath } from "./paths.ts";

const { join } = hostPath;

/** `path.posix.matchesGlob`, with the options Node passes to minimatch. */
const matchesGlob = (path: string, glob: string) =>
  minimatch(path, glob, {
    nocase: process.platform === "darwin" || process.platform === "win32",
    windowsPathsNoEscape: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    // Node passes "posix"; minimatch only distinguishes win32 from everything else.
    platform: "linux",
    nocaseMagicOnly: true,
  });

const nodeFileSystem = Effect.scoped(
  Layer.build(NodeFileSystem.layer).pipe(
    Effect.map((services) => Context.get(services, FileSystem.FileSystem)),
  ),
);

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

const gitFiles = Effect.fn("FileListing.gitFiles")(function* (root: string, directory: string) {
  const git = yield* Effect.scoped(
    Layer.build(NodeFileSystem.layer).pipe(
      Effect.flatMap((services) => Effect.provideContext(findExecutable("git"), services)),
    ),
  );
  if (!isTruthy(git)) return null;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        NodeChildProcessSpawner.layer.pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        ),
      );
      const spawner = Context.get(services, ChildProcessSpawner.ChildProcessSpawner);
      const child = yield* spawner.spawn(
        ChildProcess.make(
          git,
          ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", directory],
          {
            cwd: root,
            windowsHide: true,
            env: gitEnvironment(git),
            extendEnv: false,
            stderr: "ignore",
          },
        ),
      );
      const stdout = yield* gitOutputText({
        stdout: child.stdout,
        maxBytes: 256 * 1024 * 1024,
        overflow: "git listing output exceeds 256 MiB",
      });
      const code = yield* child.exitCode;
      return Number(code) === 0 ? stdout.split("\0").filter(Boolean) : null;
    }),
  ).pipe(
    // Without a usable git listing the caller walks the directory itself.
    Effect.catchTags({
      PlatformError: () => Effect.succeed(null),
      UnknownError: () => Effect.succeed(null),
    }),
  );
});

/** Files a walk listed in visiting order, credential-looking directories it left out, and whether it stopped. */
interface Walk {
  readonly files: Chunk.Chunk<string>;
  readonly excluded: number;
  readonly truncated: boolean;
}

/**
 * Regular files below `directory` (relative to `base`), not following links and not descending
 * into `.git`, `node_modules` or credential-looking directories. Directory names are judged as
 * `credentialPrefix` joined with the relative path: empty for a project, whose root may itself sit
 * under an unusual name, and the absolute base outside, where `~/.config` + `gh` must still match.
 */
const walkFiles = Effect.fn("FileListing.walkFiles")(function* (
  base: string,
  directory: string,
  credentialPrefix: string,
) {
  const fs = yield* nodeFileSystem;
  /**
   * One directory's entries, each with whether `room` files were already listed from it when it
   * arrived; reading stops at the first such entry.
   */
  const readDirectory = (relative: string, room: number) =>
    Stream.unwrap(
      Effect.map(fs.openDirectory(join(base, relative)), (handle) =>
        Stream.fromEffectRepeat(handle.read).pipe(Stream.takeWhile(Option.isSome)),
      ),
    ).pipe(
      // An unreadable directory is skipped; what it yielded before failing is kept.
      Stream.catchTag("PlatformError", () => Stream.empty),
      Stream.mapAccum(
        () => 0,
        (listed, { value: entry }) => [
          entry.type === "File" ? listed + 1 : listed,
          [{ entry, full: listed >= room }],
        ],
      ),
      Stream.takeUntil(({ full }) => full),
      Stream.runCollect,
    );
  /** Walks `relative` and then its subdirectories, `listed` files having been listed before it. */
  const walk = (relative: string, listed: number): Effect.Effect<Walk> =>
    Effect.gen(function* () {
      if (listed >= walkLimit) return { files: Chunk.empty(), excluded: 0, truncated: true };
      // Finish and close this directory before visiting children, so depth never consumes more FDs.
      const entries = yield* readDirectory(relative, walkLimit - listed);
      const read = entries
        .filter(({ full }) => !full)
        .map(({ entry }) => ({
          entry,
          path: relative === "." ? entry.name : `${relative}/${entry.name}`,
        }));
      const directories = read
        .filter(({ entry }) => entry.type === "Directory" && !HashSet.has(walkSkips, entry.name))
        .map(({ path }) => path);
      const credential = (path: string) => isCredentialPath(join(credentialPrefix, path));
      const here: Walk = {
        files: Chunk.fromIterable(
          read.filter(({ entry }) => entry.type === "File").map(({ path }) => path),
        ),
        excluded: directories.filter(credential).length,
        truncated: entries.some(({ full }) => full),
      };
      // The last subdirectory read is visited first, as from a stack of pending directories.
      return yield* Effect.reduce(
        directories.filter((path) => !credential(path)).toReversed(),
        () => here,
        (walked, child) =>
          walked.truncated
            ? Effect.succeed(walked)
            : Effect.map(walk(child, listed + Chunk.size(walked.files)), (below) => ({
                files: Chunk.appendAll(walked.files, below.files),
                excluded: walked.excluded + below.excluded,
                truncated: below.truncated,
              })),
      );
    });
  const walked = yield* walk(directory, 0);
  return { ...walked, files: Chunk.toReadonlyArray(walked.files) };
});

/**
 * Every regular file below `directory` (project-relative, already validated), optionally filtered
 * by a glob relative to that directory. Symlinks, `.git` and credential-looking files are left out;
 * a tracked file deleted from disk is not listed.
 */
export const listProjectFilesEffect = Effect.fn("FileListing.project")(function* (
  root: string,
  directory: string,
  glob: string | undefined,
) {
  const fromGit = yield* gitFiles(root, directory);
  const walked = isTruthy(fromGit) ? undefined : yield* walkFiles(root, directory, "");
  const prefix = directory === "." ? "" : `${directory}/`;
  const listed = EffectArray.dedupe(fromGit ?? walked?.files ?? []).filter(
    (path) =>
      path.startsWith(prefix) &&
      (glob === undefined || matchesGlob(path.slice(prefix.length), glob)) &&
      !path.split("/").some((segment) => segment.toLowerCase() === ".git"),
  );
  const kept = listed.filter((path) => !isCredentialPath(path));
  const excluded = (walked?.excluded ?? 0) + listed.length - kept.length;
  // A walk already saw regular files only. Git lists links and deleted files too, so check those,
  // many at a time.
  const fs = yield* nodeFileSystem;
  const paths = isTruthy(fromGit)
    ? (yield* Effect.forEach(
        kept,
        (path) =>
          fs.lstat(join(root, path)).pipe(
            // A path git lists but that is gone or unreadable now is left out.
            Effect.catchTag("PlatformError", () => Effect.void),
            Effect.map((entry) => (entry?.type === "File" ? path : null)),
          ),
        { concurrency: statConcurrency },
      )).filter((path) => path !== null)
    : kept;
  return {
    paths: paths.toSorted(),
    source: isTruthy(fromGit) ? "git" : "walk",
    excluded,
    truncated: walked?.truncated ?? false,
  } satisfies FileListing;
});

/**
 * Every regular file below an outside `directory` (canonical, already validated), as absolute
 * paths, optionally filtered by a glob relative to it. Never uses Git ignore rules: outside
 * listings show what is on disk, minus links, `.git`, `node_modules` and credentials.
 */
export const listOutsideFilesEffect = Effect.fn("FileListing.outside")(function* (
  directory: string,
  glob: string | undefined,
) {
  const walked = yield* walkFiles(directory, ".", directory);
  const listed = walked.files
    .filter((relative) => glob === undefined || matchesGlob(relative, glob))
    .map((relative) => join(directory, relative));
  const paths = listed.filter((absolute) => !isCredentialPath(absolute));
  return {
    paths: paths.toSorted(),
    source: "walk",
    excluded: walked.excluded + listed.length - paths.length,
    truncated: walked.truncated,
  } satisfies FileListing;
});

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
  Effect.gen(function* () {
    const services = yield* Effect.scoped(Layer.build(NodeCrypto.layer));
    const crypto = Context.get(services, Crypto.Crypto);
    /** Oldest first; the snapshot just added is the newest. */
    const entries = yield* Ref.make<ReadonlyArray<Snapshot>>([]);
    return {
      add: Effect.fnUntraced(function* (
        root: string,
        directory: string,
        glob: string | undefined,
        listing: FileListing,
      ) {
        const snapshot: Snapshot = {
          id: yield* crypto.randomUUIDv4(),
          root,
          directory,
          glob,
          ...listing,
        };
        yield* Ref.update(entries, (kept) => [...kept, snapshot].slice(-capacity));
        return snapshot;
      }),

      /** A snapshot taken for this project root, or undefined when unknown or evicted. */
      get: (id: string, root: string) =>
        Effect.map(Ref.get(entries), (kept) =>
          kept.find((snapshot) => snapshot.id === id && snapshot.root === root),
        ),
    };
  });
