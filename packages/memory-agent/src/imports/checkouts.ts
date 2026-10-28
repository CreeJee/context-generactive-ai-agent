import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Array as EffectArray, Context, Effect, FileSystem, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { gitEnvironment } from "../files/git-grep.ts";
import { canonicalPathEffect } from "../files/paths.ts";
import { findExecutable } from "../runtime/host.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { basename, dirname, isAbsolute, join, relative, sep } = platformPath;

/**
 * Which checkout a recorded working directory belongs to. Coding agents work in git worktrees
 * (Orca, Conductor, `claude --worktree`, Codex): a conversation there belongs to the repository's
 * own project, not to a project per worktree. Only git or the transcript's own git record decides;
 * a folder is never matched by a name that merely looks alike.
 */

/** What a transcript recorded about the repository it ran in. */
export interface RepositoryEvidence {
  readonly remoteUrl: string | null;
  readonly commit: string | null;
}

/** Where a conversation belongs, and the worktree it ran in when that was not the checkout. */
export interface Placed {
  readonly path: string;
  readonly worktree: string | null;
}

/** A registered root with the folders it was seen making worktrees in on earlier passes. */
export interface KnownRoot {
  readonly root: string;
  readonly worktreeParents: readonly string[];
}

/** A registered project that is a repository's main checkout. */
interface Repository {
  /** As registered. */
  readonly root: string;
  /** As git spells it: links resolved. */
  readonly real: string;
  readonly remote: string | null;
  /** The folders its linked worktrees are made in now, such as `~/orca/workspaces/<repo>`. */
  readonly seenParents: readonly string[];
  /** Those and the ones seen before, whose worktrees may all be gone by now. */
  readonly worktreeParents: readonly string[];
}

/** Repositories looked at at once; each is a handful of short git calls. */
const gitConcurrency = 4;

const commitPattern = /^[0-9a-f]{7,64}$/u;

/** `git@github.com:a/b.git`, `ssh://git@github.com/a/b`, `https://github.com/a/b` → `github.com/a/b`. */
export const remoteKey = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//u, "")
    .replace(/^[^@/]+@/u, "")
    .replace(/^([^/:]+):(?!\d)/u, "$1/")
    .replace(/\.git\/?$/u, "")
    .replace(/\/+$/u, "");

/** `child` below `parent`, as the path under it; none when it is `parent` itself or outside. */
const below = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
    ? Option.none()
    : Option.some(path);
};

const single = <A>(found: readonly A[]) =>
  found.length === 1 ? Option.fromNullishOr(found[0]) : Option.none<A>();

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = yield* findExecutable("git");
  const canonicalPath = (path: string) =>
    canonicalPathEffect(path).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  /** Git's output when it answered; none when it could not (no git, no repository, no folder). */
  const output = (cwd: string, args: readonly string[]) =>
    git === null
      ? Effect.succeedNone
      : Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(git, args, {
                cwd,
                windowsHide: true,
                env: gitEnvironment(git),
                extendEnv: false,
                stderr: "ignore",
              }),
            );
            const [text, code] = yield* Effect.all(
              [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
              { concurrency: 2 },
            );
            return Number(code) === 0 ? Option.some(text.trim()) : Option.none();
          }),
          // A folder git cannot be run in is left as it was recorded, as before worktrees mattered.
        ).pipe(Effect.catchTag("PlatformError", () => Effect.succeedNone));

  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

  /** `cwd`'s place in its repository's main checkout when `cwd` is in a linked worktree. */
  const mainCheckout = (cwd: string): Effect.Effect<Option.Option<Placed>> =>
    output(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]).pipe(
      Effect.flatMap((answer) =>
        Effect.map(
          canonicalPath(cwd).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(cwd))),
          (real) =>
            Option.flatMap(answer, (text) => {
              const [top, gitDir, common] = lines(text);
              const linked =
                top !== undefined &&
                common !== undefined &&
                gitDir !== common &&
                basename(common) === ".git";
              return linked
                ? Option.some({ path: join(dirname(common), relative(top, real)), worktree: top })
                : Option.none();
            }),
        ),
      ),
    );

  /**
   * A folder that holds nothing but these worktrees, or is gone. One that also holds other folders
   * (worktrees made among unrelated checkouts) cannot say a gone folder in it was one of them.
   */
  const holdsOnly = (parent: string, linked: readonly string[]) => {
    const others = fs.readDirectory(parent).pipe(
      Effect.flatMap((names) =>
        Effect.filter(
          names.map((name) => join(parent, name)).filter((path) => !linked.includes(path)),
          (path) => Effect.map(fs.stat(path), (info) => info.type === "Directory"),
        ),
      ),
    );
    return fs.exists(parent).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.map(others, EffectArray.isArrayEmpty) : Effect.succeed(true),
      ),
      Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    );
  };

  /** A registered root that is a main checkout, with what identifies it and its worktrees. */
  const repositoryAt = ({ root, worktreeParents: known }: KnownRoot) =>
    Effect.gen(function* () {
      const answer = yield* output(root, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ]);
      const real = yield* canonicalPath(root).pipe(
        Effect.catchTag("PlatformError", () => Effect.succeed(root)),
      );
      const isMain = Option.exists(answer, (text) => {
        const [top, common] = lines(text);
        return top === real && common === join(real, ".git");
      });
      const described = Effect.all([
        output(root, ["config", "--get", "remote.origin.url"]),
        output(root, ["worktree", "list", "--porcelain"]),
      ]).pipe(
        Effect.flatMap(([remote, worktrees]) => {
          const linked = Option.match(worktrees, {
            onNone: () => [],
            onSome: (text) =>
              lines(text)
                .filter((line) => line.startsWith("worktree "))
                .map((line) => line.slice("worktree ".length))
                .filter((path) => path !== real),
          });
          const seenParents = EffectArray.dedupe(linked.map(dirname));
          return Effect.map(
            Effect.filter(
              EffectArray.dedupe([...seenParents, ...known]),
              (parent) => holdsOnly(parent, linked),
              { concurrency: gitConcurrency },
            ),
            (worktreeParents) =>
              Option.some<Repository>({
                root,
                real,
                remote: Option.getOrNull(Option.map(remote, remoteKey)),
                seenParents,
                worktreeParents,
              }),
          );
        }),
      );
      return yield* isMain ? described : Effect.succeedNone;
    });

  const hasCommit = (repository: Repository, commit: string) =>
    Effect.map(output(repository.root, ["cat-file", "-e", `${commit}^{commit}`]), Option.isSome);

  /**
   * Resolves working directories against the registered roots of one pass. The repositories are
   * read once, the first time a folder needs them.
   */
  const forRoots = (roots: readonly KnownRoot[]) =>
    Effect.gen(function* () {
      const repositories = yield* Effect.cached(
        Effect.forEach(roots, repositoryAt, { concurrency: gitConcurrency }).pipe(
          Effect.map(EffectArray.getSomes),
        ),
      );

      /** The one repository the transcript's remote, or else its commit, points to. */
      const byEvidence = (cwd: string, evidence: RepositoryEvidence) =>
        Effect.gen(function* () {
          const all = yield* repositories;
          const remote = evidence.remoteUrl === null ? null : remoteKey(evidence.remoteUrl);
          const byRemote = all.filter(
            (repository) => remote !== null && repository.remote === remote,
          );
          // Two clones of one remote, or no remote recorded: the commit tells them apart.
          const commit = Option.filter(Option.fromNullishOr(evidence.commit), (hash) =>
            commitPattern.test(hash),
          );
          const byCommit = (hash: string) =>
            Effect.filter(
              byRemote.length > 1 ? byRemote : all,
              (repository) => hasCommit(repository, hash),
              { concurrency: gitConcurrency },
            ).pipe(Effect.map(single));
          const found = yield* Option.match(single(byRemote), {
            onSome: (repository) => Effect.succeedSome(repository),
            onNone: () =>
              Option.match(commit, { onNone: () => Effect.succeedNone, onSome: byCommit }),
          });
          // Only the folder is known to have been a worktree, not where its top was.
          return Option.map(found, (repository): Placed => ({
            path: repository.root,
            worktree: cwd,
          }));
        });

      /**
       * A worktree that is gone, found by the folder its repository makes worktrees in. A folder
       * that holds a repository itself (worktrees made beside the checkout) names nothing.
       */
      const byWorktreeParent = (cwd: string) =>
        Effect.map(repositories, (all) => {
          const holdsCheckout = (parent: string) =>
            all.some(
              (repository) =>
                repository.real === parent || Option.isSome(below(parent, repository.real)),
            );
          const places = all.flatMap((repository) =>
            repository.worktreeParents
              .filter((parent) => !holdsCheckout(parent))
              .flatMap((parent) =>
                Option.match(below(parent, cwd), {
                  onNone: () => [],
                  // The first segment is the worktree's own folder; the rest is where in it.
                  onSome: (path): Placed[] => {
                    const [name = "", ...inside] = path.split(sep);
                    return [
                      { path: join(repository.root, ...inside), worktree: join(parent, name) },
                    ];
                  },
                }),
              ),
          );
          return single(EffectArray.dedupeWith(places, (a, b) => a.path === b.path));
        });

      const answer = (step: Effect.Effect<Option.Option<Placed>>) =>
        Effect.flatMap(step, (found) => Effect.fromOption(found));

      /**
       * Where the conversation in `cwd` belongs: its place in the main checkout when `cwd` is a
       * worktree, `cwd` itself when it is any other folder that exists, and for a folder that is
       * gone the repository its git record or its worktree folder names. Otherwise `cwd` as it is.
       */
      const resolve = (cwd: string, evidence: RepositoryEvidence | null) => {
        const asRecorded: Placed = { path: cwd, worktree: null };
        return Effect.firstSuccessOf([
          answer(mainCheckout(cwd)),
          answer(
            fs.exists(cwd).pipe(
              Effect.map((exists) => (exists ? Option.some(asRecorded) : Option.none())),
              Effect.catchTag("PlatformError", () => Effect.succeedNone),
            ),
          ),
          answer(evidence === null ? Effect.succeedNone : byEvidence(cwd, evidence)),
          answer(byWorktreeParent(cwd)),
        ]).pipe(Effect.catchTag("NoSuchElementError", () => Effect.succeed(asRecorded)));
      };

      /** The worktree folders git showed for each repository this pass, to keep for later passes. */
      const seen = Effect.map(repositories, (all) =>
        all.map((repository) => ({ root: repository.root, parents: repository.seenParents })),
      );

      return { resolve, seen };
    });

  return { forRoots };
});

/** Git, asked which repository a folder belongs to. */
export class Checkouts extends Context.Service<Checkouts, Effect.Success<typeof make>>()(
  "memory-agent/imports/checkouts",
) {
  static readonly layer = Layer.effect(Checkouts, make).pipe(
    Layer.provide(
      NodeChildProcessSpawner.layer.pipe(
        Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  );
}

/** Where one pass places recorded working directories. */
export type Placement = Effect.Success<ReturnType<Checkouts["Service"]["forRoots"]>>;
