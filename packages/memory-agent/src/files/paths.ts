import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Data, Either } from "effect";

/**
 * Why a path was refused. Messages the model sees name the reason, never file contents.
 *
 * - `invalid_path`: empty, `.`/`..` segments, backslashes, control characters, or wrong absoluteness
 * - `credential`: looks like secret material (R04/R05: no approval ever unlocks it)
 * - `git_internal`: inside `.git` (R04: direct changes are excluded)
 * - `inside_project`: an outside tool was pointed at the project; use the project tools
 * - `symlink` / `hard_link`: a link could redirect the operation past these checks
 * - `not_found` / `not_file` / `not_directory`: the filesystem does not match the request
 */
export class PathRejected extends Data.TaggedError("PathRejected")<{
  readonly path: string;
  readonly reason:
    | "invalid_path"
    | "credential"
    | "git_internal"
    | "inside_project"
    | "symlink"
    | "hard_link"
    | "not_found"
    | "not_file"
    | "not_directory";
}> {}

type Reason = PathRejected["reason"];
const reject = (path: string, reason: Reason) => Either.left(new PathRejected({ path, reason }));

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
const credentialFileNames = new Set([
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
    credentialFileNames.has(name) ||
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
export function pathsOverlap(left: string, right: string): boolean {
  const contains = (root: string, candidate: string) => {
    const path = relative(root, candidate);
    return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
  };
  return contains(left, right) || contains(right, left);
}

const lstat = (path: string): Stats | undefined => lstatSync(path, { throwIfNoEntry: false });

/**
 * Canonical absolute path with symlinks resolved and the on-disk letter case. A path that does
 * not exist yet resolves through its nearest existing parent, so a symlinked parent cannot hide
 * where a new file would really land.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(canonicalPath(parent), basename(path));
  }
}

/**
 * True when `candidate` is `directory` or below it, compared by device and inode so a different
 * letter case on a case-insensitive volume cannot slip past.
 */
function isSameOrBelow(directory: string, candidate: string): boolean {
  const target = lstat(directory);
  if (!target) return pathsOverlap(directory, candidate);
  for (let current = candidate; ; current = dirname(current)) {
    const stats = lstat(current);
    if (stats && stats.dev === target.dev && stats.ino === target.ino) return true;
    if (dirname(current) === current) return false;
  }
}

export interface ProjectPath {
  /** Absolute host path below the project root. */
  readonly absolute: string;
  /** The project-relative spelling, `/`-separated. */
  readonly relative: string;
  /** Current entry, or undefined when creating. */
  readonly stats: Stats | undefined;
}

/**
 * Resolves a project-relative path for a file tool, one segment at a time with `lstat`,
 * so no symlink anywhere on the way can point the operation outside the project.
 *
 * `kind` states what the caller needs: an existing `file`, an existing `directory`, or a
 * `new-or-file` target whose missing parents the caller may create. This is a local capability
 * check, not an OS sandbox against a concurrent directory swap.
 */
export function resolveProjectPath(
  root: string,
  path: string,
  kind: "file" | "directory" | "new-or-file",
): Either.Either<ProjectPath, PathRejected> {
  const spelled = path === "" ? "." : path;
  if (isAbsolute(spelled) || spelled.includes("\\") || hasControlCharacter(spelled))
    return reject(path, "invalid_path");
  const segments = spelled === "." ? [] : spelled.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.trim() !== segment,
    )
  )
    return reject(path, "invalid_path");
  if (segments.some((segment) => segment.toLowerCase() === ".git"))
    return reject(path, "git_internal");
  if (isCredentialPath(spelled)) return reject(path, "credential");

  let current = root;
  let stats = lstat(root);
  if (!stats?.isDirectory()) return reject(path, "not_found");
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    current = join(current, segment);
    stats = lstat(current);
    if (!stats) {
      if (kind === "new-or-file")
        return Either.right({ absolute: join(root, ...segments), relative: spelled, stats });
      return reject(path, "not_found");
    }
    if (stats.isSymbolicLink()) return reject(path, "symlink");
    if (!last && !stats.isDirectory()) return reject(path, "not_directory");
  }

  if (kind === "directory") {
    if (!stats?.isDirectory()) return reject(path, "not_directory");
  } else {
    if (!stats?.isFile()) return reject(path, "not_file");
    if (stats.nlink !== 1) return reject(path, "hard_link");
  }
  return Either.right({ absolute: current, relative: spelled, stats });
}

export interface OutsidePath {
  /** Canonical absolute path, symlinks resolved. */
  readonly absolute: string;
  readonly stats: Stats | undefined;
}

/**
 * Resolves an absolute path outside the project for the outside tools (R04 `read_outside_file`,
 * approval-gated writes).
 *
 * The credential check runs on both the spelling and the canonical target, so a harmless-looking
 * symlink cannot reach `~/.ssh`. Paths inside the project, or inside the app storage root, are
 * refused: project files have their own tools with their own link rules.
 */
export function resolveOutsidePath(
  projectRoot: string,
  storageRoot: string,
  path: string,
  kind: "file" | "directory" | "new-or-file",
): Either.Either<OutsidePath, PathRejected> {
  if (!isAbsolute(path) || hasControlCharacter(path)) return reject(path, "invalid_path");
  const spelled = resolve(path);
  if (isCredentialPath(spelled)) return reject(path, "credential");

  const canonical = canonicalPath(spelled);
  const stats = lstat(canonical);
  if (!stats && kind !== "new-or-file") return reject(path, "not_found");
  if (isCredentialPath(canonical)) return reject(path, "credential");
  if (canonical.split(sep).some((segment) => segment.toLowerCase() === ".git"))
    return reject(path, "git_internal");
  if (isSameOrBelow(projectRoot, canonical)) return reject(path, "inside_project");
  if (isSameOrBelow(storageRoot, canonical)) return reject(path, "credential");

  if (!stats) return Either.right({ absolute: canonical, stats });
  if (kind === "directory") {
    if (!stats.isDirectory()) return reject(path, "not_directory");
  } else {
    if (!stats.isFile()) return reject(path, "not_file");
    if (stats.nlink !== 1) return reject(path, "hard_link");
  }
  return Either.right({ absolute: canonical, stats });
}
