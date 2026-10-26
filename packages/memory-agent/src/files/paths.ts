import {
  Context as PlatformContext,
  Effect as PlatformEffect,
  Layer as PlatformLayer,
  Path,
  FileSystem,
} from "effect";
import { Function as EffectFunction } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, HashSet, Option, Schema } from "effect";
import type { PlatformError } from "effect";

// Path operations remain synchronous at these public host boundaries.
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodePath.layer);
      return PlatformContext.get(services, Path.Path);
    }),
  ),
);

/**
 * Why a path was refused. Messages the model sees name the reason, never file contents.
 *
 * - `invalid_path`: empty, `.`/`..` segments, backslashes, control characters, or wrong absoluteness
 * - `credential`: looks like secret material (R04/R05: no approval ever unlocks it)
 * - `git_internal`: inside `.git` (R04: direct changes are excluded)
 * - `inside_project`: an outside tool was pointed at the project; use the project tools
 * - `outside_tool_root`: a fenced run (a kanban card) reached a root it must not touch
 * - `symlink` / `hard_link`: a link could redirect the operation past these checks
 * - `not_found` / `not_file` / `not_directory`: the filesystem does not match the request
 */
export class PathRejected extends Schema.TaggedError<PathRejected>()("PathRejected", {
  path: Schema.String,
  reason: Schema.Literals([
    "invalid_path",
    "credential",
    "git_internal",
    "inside_project",
    "outside_tool_root",
    "symlink",
    "hard_link",
    "not_found",
    "not_file",
    "not_directory",
  ]),
}) {}

type Reason = PathRejected["reason"];
const reject = (path: string, reason: Reason) => Effect.fail(PathRejected.make({ path, reason }));

/** Directories whose whole contents are credential material, matched as consecutive segments. */
const credentialDirectories = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".keychains",
  "keychains",
  ".codex",
  ".context-generactive-agent",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".cargo/credentials.d",
  ".mozilla",
  ".thunderbird",
  "etc/ssh",
  "google/chrome",
  "chromium",
  "bravesoftware",
  "firefox",
].map((directory) => directory.split("/"));

/** File names that hold secrets wherever they are. Compared lowercased. */
const credentialFileNames = HashSet.fromIterable([
  ".netrc",
  "_netrc",
  ".pgpass",
  ".htpasswd",
  ".npmrc",
  ".pypirc",
  ".dockercfg",
  ".envrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts",
  "shadow",
  "master.passwd",
  "sudoers",
  "master.key",
  "secring.gpg",
  "keyring.gpg",
  "logins.json",
  "key3.db",
  "key4.db",
  "cookies.sqlite",
  "login data",
  "login data for account",
]);

/** `.env` and `.env.production`, but not the committed `.env.example` family. */
const envFile = /^\.env(\.(?!example$|sample$|template$)[^/]*)?$/i;
const credentialExtension = /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg|ppk)$/i;
/**
 * A segment whose name ends in a secret word, like `secrets/`, `aws-credentials.txt` or
 * `private_key.json`. The word must end the name so `password-reset.tsx` stays ordinary code, and
 * `tokens` is absent because lexer and design-token files are common.
 */
const credentialWord =
  /^([a-z0-9]+[_.-])*(secrets?|credentials?|passwords?|api[-_]?keys?|private[-_]?keys?)(\.[a-z0-9]+)*$/i;

/**
 * True when a path looks like credential material. A name-based guard, not a classifier:
 * it cannot see secrets inside ordinary files.
 */
export function isCredentialPath(path: string): boolean {
  const segments = path
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? "";
  const inCredentialDirectory = credentialDirectories.some((directory) =>
    segments.some((_, start) =>
      directory.every((part, offset) => segments[start + offset] === part),
    ),
  );
  return (
    inCredentialDirectory ||
    HashSet.has(credentialFileNames, name) ||
    envFile.test(name) ||
    credentialExtension.test(name) ||
    segments.some((segment) => credentialWord.test(segment))
  );
}

const hasControlCharacter = (path: string) =>
  Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

/** True when one absolute path equals or contains the other, compared by spelling. */
export const pathsOverlap: {
  (right: string): (left: string) => ReturnType<typeof pathsOverlapBody>;
} & typeof pathsOverlapBody = EffectFunction.dual(2, pathsOverlapBody);
function pathsOverlapBody(left: string, right: string): boolean {
  const contains = (root: string, candidate: string) => {
    const path = relative(root, candidate);
    return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
  };
  return contains(left, right) || contains(right, left);
}

// These exports are host filesystem boundaries, like text.ts. Build the first-party service once;
// every inspection remains an interruptible Effect, with PlatformError in its failure channel.
const fileSystem = PlatformEffect.runSync(
  PlatformEffect.scoped(
    PlatformEffect.gen(function* () {
      const services = yield* PlatformLayer.build(NodeFileSystem.layer);
      return PlatformContext.get(services, FileSystem.FileSystem);
    }),
  ),
);
const lstat = (path: string) =>
  fileSystem.lstat(path).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.map(Option.getOrUndefined),
  );

/**
 * Canonical absolute path with symlinks resolved and the on-disk letter case. A path that does
 * not exist yet resolves through its nearest existing parent, so a symlinked parent cannot hide
 * where a new file would really land. Only missing suffixes resolve this way; permission and I/O
 * failures must not become a guessed path.
 */
export const canonicalPathEffect = Effect.fn("Paths.canonicalPath")(function* (
  path: string,
): Effect.fn.Return<string, PlatformError.PlatformError> {
  return yield* fileSystem.realPath(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = dirname(path);
      return parent === path
        ? Effect.succeed(path)
        : canonicalPathEffect(parent).pipe(
            Effect.map((resolved) => join(resolved, basename(path))),
          );
    }),
  );
});

/**
 * True when `candidate` is `directory` or below it, compared by device and inode so a different
 * letter case on a case-insensitive volume cannot slip past.
 */
const isSameOrBelow = Effect.fn("Paths.isSameOrBelow")(function* (
  directory: string,
  candidate: string,
) {
  // A linked root protects what it points to; lstat on the link itself never matches a candidate.
  const root = yield* canonicalPathEffect(directory);
  const target = yield* lstat(root);
  if (!(target !== undefined)) return pathsOverlap(root, candidate);
  if (Option.isNone(target.ino)) return yield* reject(candidate, "invalid_path");
  for (let current = candidate; ; current = dirname(current)) {
    const stats = yield* lstat(current);
    if (
      stats !== undefined &&
      stats.dev === target.dev &&
      Option.isSome(stats.ino) &&
      Option.isSome(target.ino) &&
      stats.ino.value === target.ino.value
    )
      return true;
    if (stats !== undefined && Option.isNone(stats.ino))
      return yield* reject(candidate, "invalid_path");
    if (dirname(current) === current) return false;
  }
});

export interface ProjectPath {
  /** Absolute host path below the project root. */
  readonly absolute: string;
  /** The project-relative spelling, `/`-separated. */
  readonly relative: string;
  /** Current entry, or undefined when creating. */
  readonly stats: FileSystem.File.Info | undefined;
}

/**
 * Resolves a project-relative path for a file tool, one segment at a time with `lstat`,
 * so no symlink anywhere on the way can point the operation outside the project.
 *
 * `kind` states what the caller needs: an existing `file`, an existing `directory`, or a
 * `new-or-file` target whose missing parents the caller may create. This is a local capability
 * check, not an OS sandbox against a concurrent directory swap.
 */
export const resolveProjectPath: {
  (
    path: string,
    kind: "file" | "directory" | "new-or-file",
  ): (root: string) => ReturnType<typeof resolveProjectPathBody>;
} & typeof resolveProjectPathBody = EffectFunction.dual(3, resolveProjectPathBody);
function resolveProjectPathBody(
  root: string,
  path: string,
  kind: "file" | "directory" | "new-or-file",
): Effect.Effect<ProjectPath, PathRejected | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const spelled = path === "" ? "." : path;
    if (isAbsolute(spelled) || spelled.includes("\\") || hasControlCharacter(spelled))
      return yield* reject(path, "invalid_path");
    const segments = spelled === "." ? [] : spelled.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === ".." || segment.trim() !== segment,
      )
    )
      return yield* reject(path, "invalid_path");
    if (segments.some((segment) => segment.toLowerCase() === ".git"))
      return yield* reject(path, "git_internal");
    if (isCredentialPath(spelled)) return yield* reject(path, "credential");

    let current = root;
    let stats = yield* lstat(root);
    if (!(stats?.type === "Directory")) return yield* reject(path, "not_found");
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      current = join(current, segment);
      stats = yield* lstat(current);
      if (!(stats !== undefined)) {
        if (kind === "new-or-file")
          return yield* Effect.succeed({
            absolute: join(root, ...segments),
            relative: spelled,
            stats,
          });
        return yield* reject(path, "not_found");
      }
      if (stats.type === "SymbolicLink") return yield* reject(path, "symlink");
      if (!last && stats.type !== "Directory") return yield* reject(path, "not_directory");
    }

    if (kind === "directory") {
      if (stats?.type !== "Directory") return yield* reject(path, "not_directory");
    } else {
      if (stats?.type !== "File") return yield* reject(path, "not_file");
      if (!Option.contains(stats.nlink, 1)) return yield* reject(path, "hard_link");
    }
    return { absolute: current, relative: spelled, stats };
  });
}

export interface OutsidePath {
  /** Canonical absolute path, symlinks resolved. */
  readonly absolute: string;
  readonly stats: FileSystem.File.Info | undefined;
}

/**
 * Resolves an absolute path outside the project for the outside tools (R04 `read_outside_file`,
 * approval-gated writes).
 *
 * The credential check runs on both the spelling and the canonical target, so a harmless-looking
 * symlink cannot reach `~/.ssh`. Paths inside the project, or inside the app storage root, are
 * refused: project files have their own tools with their own link rules.
 */
export const resolveOutsidePath: {
  (
    storageRoot: string,
    path: string,
    kind: "file" | "directory" | "new-or-file",
  ): (projectRoot: string) => ReturnType<typeof resolveOutsidePathBody>;
} & typeof resolveOutsidePathBody = EffectFunction.dual(4, resolveOutsidePathBody);
function resolveOutsidePathBody(
  projectRoot: string,
  storageRoot: string,
  path: string,
  kind: "file" | "directory" | "new-or-file",
): Effect.Effect<OutsidePath, PathRejected | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!isAbsolute(path) || hasControlCharacter(path)) return yield* reject(path, "invalid_path");
    const spelled = resolve(path);
    if (isCredentialPath(spelled)) return yield* reject(path, "credential");

    const canonical = yield* canonicalPathEffect(spelled);
    const stats = yield* lstat(canonical);
    if (!(stats !== undefined) && kind !== "new-or-file") return yield* reject(path, "not_found");
    if (isCredentialPath(canonical)) return yield* reject(path, "credential");
    if (canonical.split(sep).some((segment) => segment.toLowerCase() === ".git"))
      return yield* reject(path, "git_internal");
    if (yield* isSameOrBelow(projectRoot, canonical)) return yield* reject(path, "inside_project");
    if (yield* isSameOrBelow(storageRoot, canonical)) return yield* reject(path, "credential");

    if (!(stats !== undefined)) return yield* Effect.succeed({ absolute: canonical, stats });
    if (kind === "directory") {
      if (stats.type !== "Directory") return yield* reject(path, "not_directory");
    } else {
      if (stats.type !== "File") return yield* reject(path, "not_file");
      if (!Option.contains(stats.nlink, 1)) return yield* reject(path, "hard_link");
    }
    return { absolute: canonical, stats };
  });
}

/**
 * Roots a run's outside tools must not reach besides the project and storage roots. A kanban card's
 * tools run with the card worktree as their project root and fence off the user's checkout and
 * every other card worktree. It only adds refusals; the outside rules above still apply first.
 */
export interface ToolFence {
  readonly deniedRoots: ReadonlyArray<string>;
}

/** A tool target that carries its fence, if it has one. */
export type Fenced<P> = P & { readonly toolFence?: ToolFence | undefined };

/**
 * {@link resolveOutsidePath}, then refuses a target that is a denied root, below one, or above one
 * (listing a parent would show the denied tree).
 */
export const resolveFencedOutsidePath = Effect.fn("Paths.resolveFencedOutsidePath")(function* (
  fence: ToolFence | undefined,
  projectRoot: string,
  storageRoot: string,
  path: string,
  kind: "file" | "directory" | "new-or-file",
): Effect.fn.Return<OutsidePath, PathRejected | PlatformError.PlatformError> {
  const resolved = yield* resolveOutsidePathBody(projectRoot, storageRoot, path, kind);
  yield* Effect.forEach(
    fence?.deniedRoots ?? [],
    (denied) =>
      Effect.gen(function* () {
        const root = yield* canonicalPathEffect(denied);
        if (
          pathsOverlap(root, resolved.absolute) ||
          (yield* isSameOrBelow(denied, resolved.absolute))
        )
          return yield* reject(path, "outside_tool_root");
      }),
    { discard: true },
  );
  return resolved;
});
