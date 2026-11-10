import { Array as Arr, Data, Effect, Option } from "effect";
import { homeDirectory, temporaryDirectory } from "../runtime/host-system.ts";
import { path } from "../runtime/synchronous-path.ts";
import {
  canonicalPathEffect,
  hasControlCharacter,
  isCredentialPath,
  PathRejected,
  relativeBelow,
  resolveFencedOutsidePath,
  resolveOutsidePath,
  resolveProjectPath,
  type Fenced,
} from "./paths.ts";

const { isAbsolute, relative, resolve } = path;

/**
 * The one path policy every tool asks: the file tools, the outside tools, `run_skill`'s working
 * directory, the sh skill sandbox and saving a code skill. `paths.ts` holds the checks; this module
 * decides which of them a path meets.
 *
 * - A relative path is read below the run's root.
 * - An absolute path below the run's root is read as the root-relative path it spells.
 * - In a kanban card, the run's root is a worktree copy of the user's project folder. An absolute
 *   path below that folder is read at the same place below the card's worktree, and the tool result
 *   says so (`pathMapped`).
 * - Any other absolute path is outside: only the outside tools, and `run_skill` below a temporary
 *   folder, take it.
 *
 * Paths are compared as real paths by device and inode, so a linked root (`/tmp` →
 * `/private/tmp`) or a different letter case lands in the same place. A relative path still meets
 * every project rule (no `..`, links, `.git` or credentials).
 */

/** The run a path is read for: its root, and a kanban card's fence. */
export type ToolRoots = Fenced<{ readonly root: string }>;

export type PathPlace = Data.TaggedEnum<{
  /** Below the run's root; `relative` is what the file tools take (unchecked if given relative). */
  Root: { readonly relative: string };
  /** Below the user's project folder while the run works in a card worktree: the same place there. */
  Mapped: { readonly relative: string };
  /** Absolute, and below neither. */
  Outside: { readonly absolute: string };
}>;
export const PathPlace = Data.taggedEnum<PathPlace>();

type Kind = "file" | "directory" | "new-or-file";

const reject = (given: string, reason: PathRejected["reason"]) =>
  Effect.fail(PathRejected.make({ path: given, reason }));

const toRelative = (below: string) => (below === "" ? "." : below);

const placeAbsolute = Effect.fnUntraced(function* (roots: ToolRoots, given: string) {
  yield* Effect.when(reject(given, "invalid_path"), Effect.succeed(hasControlCharacter(given)));
  const canonical = yield* canonicalPathEffect(resolve(given));
  const inUserRoot = Option.match(Option.fromNullishOr(roots.toolFence?.userRoot), {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (userRoot) => relativeBelow(userRoot, canonical),
  }).pipe(
    Effect.map(
      Option.match({
        onSome: (below): PathPlace => PathPlace.Mapped({ relative: toRelative(below) }),
        onNone: () => PathPlace.Outside({ absolute: given }),
      }),
    ),
  );
  return yield* Option.match(yield* relativeBelow(roots.root, canonical), {
    onSome: (below) => Effect.succeed<PathPlace>(PathPlace.Root({ relative: toRelative(below) })),
    onNone: () => inUserRoot,
  });
});

/** Where a tool path lands for this run. */
export const placePath = Effect.fn("PathPolicy.placePath")(function* (
  roots: ToolRoots,
  given: string,
) {
  return isAbsolute(given)
    ? yield* placeAbsolute(roots, given)
    : PathPlace.Root({ relative: given });
});

/** What a tool result tells the model when a path was read in the card's worktree instead. */
const mappedNote = (given: string, relativePath: string) =>
  `${given} is in the user's project folder. This run works in its own copy of the project, so the path was used as ${relativePath} there. Give paths relative to the project.`;

/**
 * A path for the project file tools: relative, or absolute below the run's root (or, in a card,
 * below the user's project folder). An absolute path elsewhere is `outside_project`.
 */
export const resolveRootPath = Effect.fn("PathPolicy.resolveRootPath")(function* (
  roots: ToolRoots,
  given: string,
  kind: Kind,
) {
  const inRoot = (relativePath: string, note: Option.Option<string>) =>
    Effect.map(resolveProjectPath(roots.root, relativePath, kind), (resolved) => ({
      ...resolved,
      mappedNote: note,
    }));
  return yield* PathPlace.$match(yield* placePath(roots, given), {
    Root: ({ relative: below }) => inRoot(below, Option.none()),
    Mapped: ({ relative: below }) => inRoot(below, Option.some(mappedNote(given, below))),
    Outside: () => reject(given, "outside_project"),
  });
});

/**
 * A path in the project, refused for an outside tool as `inside_project` with the project-relative
 * path the file tools take. Credentials and `.git` keep their own refusal.
 */
const insideProject = (given: string, below: string) =>
  isCredentialPath(below)
    ? reject(given, "credential")
    : below.split("/").some((segment) => segment.toLowerCase() === ".git")
      ? reject(given, "git_internal")
      : Effect.fail(PathRejected.make({ path: given, reason: "inside_project", target: below }));

/**
 * A path for the outside tools: absolute, and outside the project. A path into the project (or, in
 * a card, the user's project folder) is refused with the relative path the file tools take.
 */
export const resolveOutsideToolPath = Effect.fn("PathPolicy.resolveOutsideToolPath")(function* (
  roots: ToolRoots,
  storageRoot: string,
  given: string,
  kind: Kind,
) {
  yield* Effect.when(reject(given, "invalid_path"), Effect.succeed(!isAbsolute(given)));
  return yield* PathPlace.$match(yield* placePath(roots, given), {
    Root: ({ relative: below }) => insideProject(given, below),
    Mapped: ({ relative: below }) => insideProject(given, below),
    Outside: () => resolveFencedOutsidePath(roots.toolFence, roots.root, storageRoot, given, kind),
  });
});

/** `/tmp` and the host's temporary folder, as real paths. */
export const temporaryRoots = Effect.flatMap(temporaryDirectory, (temporary) =>
  Effect.forEach(["/tmp", temporary], canonicalPathEffect),
).pipe(Effect.map(Arr.dedupe));

/**
 * The folders a sh skill's script may write, as real paths (macOS's sandbox compares real paths):
 * the run's root and the temporary folders. A folder whose real path cannot be read keeps its
 * spelling.
 */
export const writableRoots = (root: string) =>
  Effect.map(
    Effect.all([
      canonicalPathEffect(root).pipe(Effect.orElseSucceed(() => root)),
      temporaryRoots.pipe(Effect.orElseSucceed(() => ["/tmp"])),
    ]),
    ([real, temporary]) => Arr.dedupe([real, ...temporary]),
  );

/**
 * `run_skill`'s working directory: a project path as the file tools read it, or a folder below a
 * temporary folder. `relative` is what the result shows: root-relative, or the absolute temporary
 * folder.
 */
export const resolveWorkingDirectory = Effect.fn("PathPolicy.resolveWorkingDirectory")(function* (
  roots: ToolRoots,
  storageRoot: string,
  workdir: string,
) {
  const inRoot = (below: string, note: Option.Option<string>) =>
    Effect.map(resolveProjectPath(roots.root, below, "directory"), (resolved) => ({
      absolute: resolved.absolute,
      relative: resolved.relative,
      mappedNote: note,
    }));
  const temporary = Effect.gen(function* () {
    const directory = yield* resolveOutsidePath(roots.root, storageRoot, workdir, "directory");
    const below = yield* Effect.findFirst(yield* temporaryRoots, (root) =>
      Effect.map(relativeBelow(root, directory.absolute), Option.isSome),
    );
    yield* Effect.when(reject(workdir, "outside_project"), Effect.succeed(Option.isNone(below)));
    return {
      absolute: directory.absolute,
      relative: directory.absolute,
      mappedNote: Option.none<string>(),
    };
  });
  return yield* PathPlace.$match(yield* placePath(roots, workdir), {
    Root: ({ relative: below }) => inRoot(below, Option.none()),
    Mapped: ({ relative: below }) => inRoot(below, Option.some(mappedNote(workdir, below))),
    Outside: () => temporary,
  });
});

/** An absolute spelling of one of the run's folders found in a program's text. */
export interface FolderMention {
  /** `root`: the run's root. `user`: the user's project folder, when the run is a card's. */
  readonly folder: "root" | "user";
  readonly spelling: string;
}

const escapeForPattern = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a saved program names the run's folders by absolute path: as given, as the real path, and
 * below the home folder as `~/…`, `$HOME/…` or `${HOME}/…`. A spelling counts only as a whole path
 * or followed by `/`, so `/work/app` is not found in `/work/app-old`. A skill runs in the project
 * (in a card, the card's own worktree), so such a path can leave the folder the run works in.
 */
export const folderMentions = Effect.fn("PathPolicy.folderMentions")(function* (
  roots: ToolRoots,
  text: string,
) {
  const home = yield* homeDirectory;
  const realOrSpelled = (folder: string) =>
    canonicalPathEffect(folder).pipe(Effect.orElseSucceed(() => folder));
  const homes = Arr.dedupe([home, yield* realOrSpelled(home)]);
  const spellings = Effect.fnUntraced(function* (folder: string) {
    const absolute = Arr.dedupe([folder, yield* realOrSpelled(folder)]);
    const belowHome = absolute.flatMap((spelled) =>
      homes.flatMap((base) =>
        Option.match(
          Option.liftPredicate(
            relative(base, spelled),
            (below) =>
              below !== "" && below !== ".." && !below.startsWith("../") && !isAbsolute(below),
          ),
          {
            onNone: () => [],
            onSome: (below) => [`~/${below}`, `$HOME/${below}`, `\${HOME}/${below}`],
          },
        ),
      ),
    );
    return Arr.dedupe([...absolute, ...belowHome]);
  });
  const folders: ReadonlyArray<readonly [FolderMention["folder"], string]> = [
    ["root", roots.root],
    ...Option.match(Option.fromNullishOr(roots.toolFence?.userRoot), {
      onNone: () => [],
      onSome: (userRoot) => [["user", userRoot] as const],
    }),
  ];
  const found = yield* Effect.forEach(folders, ([folder, spelled]) =>
    Effect.map(spellings(spelled), (candidates) =>
      candidates
        .filter((spelling) =>
          new RegExp(`(?<![\\w.~/$-])${escapeForPattern(spelling)}(?![\\w.-])`).test(text),
        )
        .map((spelling): FolderMention => ({ folder, spelling })),
    ),
  );
  return found.flat();
});
