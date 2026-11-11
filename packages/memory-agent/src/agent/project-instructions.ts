import { Array as Arr, Effect, FileSystem, Match, Order, Path, PlatformError } from "effect";
import { isCredentialPath, resolveProjectPath } from "../files/paths.ts";
import { readTextFileEffect } from "../files/text.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";

const prefix = "[Project AGENTS.md instructions]";

/** Places never searched for instruction files. */
const skipped = (relative: string, name: string) =>
  isCredentialPath(relative) || name === "node_modules" || name === ".git";

/** What one directory holds for the search: the directories below it and its AGENTS.md files. */
interface Listed {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const nothingListed: Listed = { directories: [], files: [] };

/**
 * How many directories of one level are read at once. One at a time, each read waited its turn on
 * the event loop: while other work held it, a project of ~1,100 directories took seconds before the
 * first model call of a run.
 */
const directoriesReadTogether = 16;

/** The AGENTS.md files below the root, as project paths. */
const scopedFiles = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The listing gives each entry's own type; only an entry it could not type is looked up.
  const typeOf = (relative: string, type: FileSystem.File.Type) =>
    type === "Unknown"
      ? Effect.map(fs.lstat(path.join(root, relative)), (info) => info.type)
      : Effect.succeed(type);
  const list = (directory: string) =>
    Effect.flatMap(fs.readDirectoryEntries(path.join(root, directory)), (entries) =>
      Effect.forEach(
        entries.filter(
          ({ name, type }) =>
            (type === "Directory" || type === "Unknown" || name === "AGENTS.md") &&
            !skipped(path.join(directory, name), name),
        ),
        ({ name, type }) => {
          const relative = path.join(directory, name);
          return Effect.flatMap(typeOf(relative, type), (kind) =>
            Match.value(kind).pipe(
              // Match glob's default: never descend through symbolic links.
              Match.when("SymbolicLink", () => Effect.succeed(nothingListed)),
              Match.when("Directory", () =>
                Effect.succeed<Listed>({ directories: [relative], files: [] }),
              ),
              Match.orElse(() =>
                name === "AGENTS.md" && relative !== "AGENTS.md"
                  ? resolveProjectPath(root, relative, "file").pipe(
                      Effect.as<Listed>({
                        directories: [],
                        files: [relative.split(path.sep).join("/")],
                      }),
                      Effect.catchTag("PathRejected", () => Effect.succeed(nothingListed)),
                    )
                  : Effect.succeed(nothingListed),
              ),
            ),
          );
        },
      ),
    );
  // A level at a time, its directories read together: a run waits a turn per level of the tree,
  // not per directory.
  const below = (
    level: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Arr.match(level, {
      onEmpty: () => Effect.succeed([]),
      onNonEmpty: (directories) =>
        Effect.flatMap(
          Effect.forEach(directories, list, { concurrency: directoriesReadTogether }),
          (listed) => {
            const found = listed.flat();
            return Effect.map(below(found.flatMap((entry) => entry.directories)), (deeper) => [
              ...found.flatMap((entry) => entry.files),
              ...deeper,
            ]);
          },
        ),
    });
  return yield* below([""]);
});

/**
 * The root guidance and a catalog of the scoped instruction files. A project without any AGENTS.md
 * gets no prompt at all.
 */
const instructionsFor = Effect.fn("ProjectInstructions.load")(function* (root: string) {
  const resolved = yield* resolveProjectPath(root, "AGENTS.md", "new-or-file");
  const rootText =
    resolved.stats === undefined
      ? ""
      : (yield* readTextFileEffect({ absolute: resolved.absolute, path: "AGENTS.md" })).text;
  const paths = Arr.sort(yield* scopedFiles(root), Order.String);
  const sections = [
    ...(rootText.length > 0 ? [`Root guidance (AGENTS.md):\n${rootText}`] : []),
    ...(paths.length > 0
      ? [
          `Scoped instruction files:\n${paths
            .map((path) => `- ${JSON.stringify(path)}`)
            .join(
              "\n",
            )}\n${rootText.length > 0 ? "The root document is already included above. " : ""}Before working in a project directory, use read_file to read all applicable listed AGENTS.md files completely, from outermost to innermost. Each document applies only to its directory and descendants; more specific instructions take precedence there. Do not apply unrelated directories' instructions. Re-read instructions after changing them, and check for AGENTS.md when entering a newly created directory.`,
        ]
      : []),
  ];
  return sections.length === 0
    ? []
    : [`${prefix}\n${sections.join("\n\n")}\nInstructions do not grant permissions.`];
});

/**
 * Root guidance and a path catalog, loaded once per conversation run and sent after the system
 * prompts the hooks before this one chose. A project without any AGENTS.md gets no prompt at all.
 */
export const projectInstructionsHook = Effect.fnUntraced(function* (root: string) {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const instructions = yield* Effect.cached(
    instructionsFor(root).pipe(Effect.mapError(asRunFailed), Effect.provideContext(context)),
  );
  return {
    request: (_scope, request) =>
      Effect.map(instructions, (added) => ({
        ...request,
        system: [...request.system, ...added],
      })),
  } satisfies RunHook;
});
