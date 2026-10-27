import { Cause } from "effect";
import { HashSet } from "effect";
import { isTruthy } from "../truthy.ts";
import { path as platformPath, posix } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import {
  Array as Arr,
  MutableHashMap,
  Option,
  Context,
  Effect,
  Fiber,
  Result,
  Layer,
  Schema,
} from "effect";
import { gitGrepFilesEffect } from "../files/git-grep.ts";
import { listProjectFilesEffect, createSnapshots, type Snapshot } from "../files/listing.ts";
import { PathRejected, resolveProjectPath } from "../files/paths.ts";
import { decodeSearchCursor, encodeSearchCursor, searchTextFilesEffect } from "../files/search.ts";
import {
  createTextFileEffect,
  deleteTextFileEffect,
  createTextPageReader,
  readFileBytesEffect,
  readTextFileEffect,
  replaceTextFileEffect,
  TextFileRejected,
  TextFileRejectedReason,
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { HiddenReplaceFailure, mentionsHidden, replaceKeepingHidden } from "../secrets/restore.ts";
import { guardedChange, guardedEffect } from "./failure.ts";
import { runTool } from "./run-tool.ts";

export const fileToolNames = [
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

const directoryField = Schema.optionalKey(
  Schema.String.annotate({
    description: 'Project-relative directory to look in. Defaults to the project root (".").',
  }),
);
const globField = Schema.optionalKey(
  Schema.String.annotate({
    description: 'Glob relative to the directory, like "**/*.ts" or "src/*.md".',
  }),
);
const sha256Field = Schema.String.annotate({
  description: "sha256 returned by the read that this change is based on.",
});

const listFilesInput = Schema.Struct({
  directory: directoryField,
  glob: globField,
  snapshot: Schema.optionalKey(
    Schema.String.annotate({ description: "snapshot from the previous page when paging." }),
  ),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: "nextOffset from the previous page when paging." }),
  ),
});

const searchFilesInput = Schema.Struct({
  query: Schema.NonEmptyString.annotate({
    description: "Literal text to find (not a regular expression).",
  }),
  directory: directoryField,
  glob: globField,
  caseSensitive: Schema.optionalKey(Schema.Boolean.annotate({ description: "Defaults to true." })),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: "nextCursor from the previous page when paging." }),
  ),
});

const readFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative file path." }),
  startLine: Schema.optionalKey(Schema.Int.annotate({ description: "1-based. Defaults to 1." })),
  maxLines: Schema.optionalKey(
    Schema.Int.annotate({ description: "Lines per page, up to 2000. Defaults to 400." }),
  ),
});

const writeFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative file path." }),
  content: Schema.String.annotate({ description: "The complete new file content." }),
  expectedSha256: Schema.optionalKey(
    sha256Field.annotate({
      description: "Required to replace an existing file: the sha256 from read_file.",
    }),
  ),
});

const editFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative file path." }),
  oldText: Schema.NonEmptyString.annotate({
    description: "Exact text to replace, including indentation. Must occur exactly once.",
  }),
  newText: Schema.String.annotate({ description: "Replacement text." }),
  replaceAll: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Replace every occurrence instead of exactly one." }),
  ),
  expectedSha256: Schema.optionalKey(sha256Field),
});

const deleteFileInput = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative file path." }),
  expectedSha256: sha256Field,
});

const listFiles = {
  name: "list_files",
  description:
    "List files in the project, recursively, honouring .gitignore in Git projects. Page with snapshot + nextOffset; a snapshot is a fixed view taken on the first page.",
  parameters: listFilesInput,
} as const;

const searchFiles = {
  name: "search_files",
  description:
    "Find literal text across project files and return matching lines with line numbers. Narrow with directory and glob. Page with nextCursor; skipped files are listed, so an empty result only covers the files actually searched.",
  parameters: searchFilesInput,
} as const;

const readFile = {
  name: "read_file",
  description:
    "Read a project text file by line range. Returns the exact content (line endings kept) and the file's sha256, which write_file, edit_file and delete_file use to avoid overwriting newer changes.",
  parameters: readFileInput,
} as const;

const writeFile = {
  name: "write_file",
  description:
    "Create a project file, or replace a whole existing file when expectedSha256 from read_file is given. Missing parent directories are created. Prefer edit_file for small changes.",
  parameters: writeFileInput,
} as const;

const editFile = {
  name: "edit_file",
  description:
    "Replace exact text in a project file. oldText must match once (or pass replaceAll). CRLF files accept oldText written with plain newlines.",
  parameters: editFileInput,
} as const;

const deleteFile = {
  name: "delete_file",
  description:
    "Delete one project file whose content still matches expectedSha256 from read_file. Directories are not deleted.",
  parameters: deleteFileInput,
} as const;

export const listPageSize = 500;

/** Search candidates kept per snapshot and query, so later pages do not ask Git again. */
const candidateCacheSize = 32;

/** The file's new text when `find` occurs once, or more than once with `replaceAll`. */
const replaced = (edit: {
  readonly path: string;
  readonly current: string;
  readonly find: string;
  readonly replacement: string;
  readonly replaceAll: boolean;
}) =>
  Effect.succeed(edit.current.split(edit.find).length - 1).pipe(
    Effect.filterOrFail(
      (occurrences) => occurrences > 0,
      () =>
        new Cause.UnknownError(
          new Error(`no_match: ${edit.path}. oldText does not occur; read the file again.`),
        ),
    ),
    Effect.filterOrFail(
      (occurrences) => occurrences <= 1 || edit.replaceAll,
      (occurrences) =>
        new Cause.UnknownError(
          new Error(
            `ambiguous_match: ${edit.path}. oldText occurs ${occurrences} times; add surrounding lines or pass replaceAll.`,
          ),
        ),
    ),
    Effect.map((occurrences) => ({
      text: edit.current.replaceAll(edit.find, () => edit.replacement),
      replacements: occurrences,
    })),
  );

const make = Effect.gen(function* () {
  const redactor = yield* SecretRedactor;
  const snapshots = yield* createSnapshots();
  const unexpired = <E>(lookup: Effect.Effect<Snapshot | undefined, E>, expired: string) =>
    Effect.flatMap(lookup, (found) =>
      Effect.fromOption(
        Option.liftPredicate(found, isTruthy),
        () => new Cause.UnknownError(new Error(expired)),
      ),
    );

  /**
   * The file's new text when the model's change mentions a hidden value. The model reads files
   * with secrets replaced by placeholders, so it writes against that view; the values the
   * placeholders stand for are put back here and never pass through the model.
   */
  const keepingHidden = Effect.fnUntraced(function* (options: {
    readonly path: string;
    readonly current: string;
    readonly find: string | null;
    readonly replacement: string;
    readonly replaceAll: boolean;
  }) {
    const view = yield* redactor.redactView(options.current);
    const replaced = replaceKeepingHidden({
      view,
      // Replacing the whole file replaces every placeholder the model read.
      find: options.find ?? view.text,
      replacement: options.replacement,
      replaceAll: options.replaceAll,
    });
    return yield* Effect.mapError(
      Effect.fromResult(replaced),
      (failure) =>
        new Cause.UnknownError(
          new Error(
            HiddenReplaceFailure.$match(failure, {
              no_match: () =>
                `no_match: ${options.path}. oldText does not occur; read the file again.`,
              ambiguous: ({ occurrences }) =>
                `ambiguous_match: ${options.path}. oldText occurs ${occurrences} times; add surrounding lines or pass replaceAll.`,
              cuts_hidden: () =>
                `hidden_value_split: ${options.path}. oldText starts or ends inside a [redacted:…] placeholder; include the whole placeholder.`,
            }),
          ),
        ),
    );
  });
  type Candidates = HashSet.HashSet<string> | null;
  const candidateCache = MutableHashMap.empty<string, Candidates>();
  const readPage = createTextPageReader();

  /** Keeps `candidates` under `key`, dropping the oldest entries past the cache's size. */
  const remember = (key: string, candidates: Candidates) =>
    Effect.sync(() => {
      MutableHashMap.set(candidateCache, key, candidates);
      Arr.take(
        Array.from(MutableHashMap.keys(candidateCache)),
        MutableHashMap.size(candidateCache) - candidateCacheSize,
      ).forEach((old) => MutableHashMap.remove(candidateCache, old));
    });

  /**
   * In a Git work tree, the files that can match at all; null means search every file. The first
   * page starts `git grep` together with the listing and owns its Fiber as `started`.
   */
  const candidatesFor = (
    view: Snapshot,
    query: string,
    caseSensitive: boolean,
    started: Option.Option<Fiber.Fiber<Candidates>>,
  ): Effect.Effect<Candidates> => {
    const key = `${view.id}\u0000${caseSensitive}\u0000${query}`;
    return view.source === "git"
      ? Option.match(MutableHashMap.get(candidateCache, key), {
          onSome: (cached) => Effect.succeed(cached),
          onNone: () =>
            Option.match(started, {
              onNone: () =>
                gitGrepFilesEffect({
                  root: view.root,
                  directory: view.directory,
                  query,
                  caseSensitive,
                }),
              onSome: Fiber.join,
            }).pipe(Effect.tap((candidates) => remember(key, candidates))),
        })
      : Effect.as(
          Option.match(started, { onNone: () => Effect.void, onSome: Fiber.interrupt }),
          null,
        );
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const snapshotFor = Effect.fn("FileTools.snapshot")(function* (
    root: string,
    directory: string | undefined,
    glob: string | undefined,
  ) {
    const resolved = yield* resolveProjectPath(root, directory ?? ".", "directory");
    return snapshots.add(
      root,
      resolved.relative,
      glob,
      yield* listProjectFilesEffect(root, resolved.relative, glob),
    );
  });

  /** The file tools' calls in project `root`, each failing with what the model reads. */
  const callsFor = (root: string) => ({
    listFiles: ({ directory, glob, snapshot, offset }: typeof listFilesInput.Type) =>
      guardedEffect(
        directory ?? ".",
        Effect.gen(function* () {
          const view = yield* unexpired(
            Option.match(Option.liftPredicate(snapshot, isTruthy), {
              onNone: () => snapshotFor(root, directory, glob),
              onSome: (id) => Effect.sync(() => snapshots.get(id, root)),
            }),
            "snapshot_expired: start again without snapshot and offset.",
          );
          const start = Math.max(0, offset ?? 0);
          const paths = view.paths.slice(start, start + listPageSize);
          const next = start + paths.length;
          return {
            snapshot: view.id,
            directory: view.directory,
            glob: view.glob ?? null,
            source: view.source,
            total: view.paths.length,
            excludedCredentialFiles: view.excluded,
            truncated: view.truncated,
            paths,
            nextOffset: next < view.paths.length ? next : null,
          };
        }),
      ),

    searchFiles: ({
      query,
      directory,
      glob,
      caseSensitive = true,
      cursor,
    }: typeof searchFilesInput.Type) =>
      guardedEffect(
        directory ?? ".",
        Effect.gen(function* () {
          // A cursor continues only the search that made it.
          const given = Option.liftPredicate(cursor, isTruthy);
          const position = yield* Effect.succeed(
            Option.flatMapNullishOr(given, decodeSearchCursor),
          ).pipe(
            Effect.filterOrFail(
              (decoded) =>
                Option.isNone(given) ||
                Option.exists(
                  decoded,
                  (at) => at.query === query && at.caseSensitive === caseSensitive,
                ),
              () =>
                new Cause.UnknownError(
                  new Error(
                    "invalid_cursor: pass the same query and caseSensitive as the first page.",
                  ),
                ),
            ),
          );
          // On the first page, ask Git for candidate files while the listing is being taken.
          const started = yield* Option.match(position, {
            onSome: () => Effect.succeedNone,
            onNone: () =>
              resolveProjectPath(root, directory ?? ".", "directory").pipe(
                Effect.flatMap((resolved) =>
                  Effect.forkChild(
                    gitGrepFilesEffect({
                      root,
                      directory: resolved.relative,
                      query,
                      caseSensitive,
                    }),
                  ),
                ),
                Effect.asSome,
              ),
          });
          const view = yield* unexpired(
            Option.match(position, {
              onSome: (at) => Effect.sync(() => snapshots.get(at.snapshot, root)),
              onNone: () => snapshotFor(root, directory, glob),
            }),
            "snapshot_expired: start the search again without cursor.",
          );

          // Each directory is checked once per page (no links, still inside the project); the file
          // itself is checked on the opened handle, so thousands of files do not mean thousands of
          // synchronous path walks.
          const directories = MutableHashMap.empty<string, Result.Result<void, PathRejected>>();
          const candidates = yield* candidatesFor(view, query, caseSensitive, started);
          const page = yield* searchTextFilesEffect({
            paths: view.paths,
            readBytes: Effect.fnUntraced(function* (path: string) {
              const directory = posix.dirname(path);
              const checked = yield* Option.match(MutableHashMap.get(directories, directory), {
                onSome: (known) => Effect.succeed(known),
                onNone: () =>
                  resolveProjectPath(root, directory, "directory").pipe(
                    Effect.as<Result.Result<void, PathRejected>>(Result.succeed(undefined)),
                    Effect.catchTag("PathRejected", (error) =>
                      Effect.succeed<Result.Result<void, PathRejected>>(Result.fail(error)),
                    ),
                    Effect.tap((result) =>
                      Effect.sync(() => MutableHashMap.set(directories, directory, result)),
                    ),
                  ),
              });
              yield* Result.match(checked, {
                onSuccess: Effect.succeed,
                onFailure: (rejection) =>
                  Effect.fail(PathRejected.make({ path, reason: rejection.reason })),
              });
              return (yield* readFileBytesEffect({
                absolute: join(root, path),
                path,
                checkLeaf: true,
              })).bytes;
            }),
            readPage: Effect.fnUntraced(function* (path: string, startLine: number) {
              const resolved = yield* resolveProjectPath(root, path, "file");
              return yield* readPage({
                absolute: resolved.absolute,
                path,
                startLine,
                maxLines: 2000,
                checkLeaf: true,
              });
            }),
            query,
            caseSensitive,
            start: Option.getOrElse(position, () => ({ file: 0, line: 0 })),
            candidates,
          });
          return {
            filesInView: view.paths.length,
            matches: page.matches,
            skipped: page.skipped,
            nextCursor: Option.getOrNull(
              Option.map(Option.fromNullishOr(page.next), (next) =>
                encodeSearchCursor({ snapshot: view.id, query, caseSensitive, ...next }),
              ),
            ),
            complete: page.next === null && page.skipped.length === 0,
          };
        }),
      ),

    readFile: ({ path, startLine, maxLines }: typeof readFileInput.Type) =>
      guardedEffect(
        path,
        Effect.gen(function* () {
          const resolved = yield* resolveProjectPath(root, path, "file");
          const lines = Math.min(Math.max(1, maxLines ?? 400), 2000);
          return {
            path,
            ...(yield* readPage({
              absolute: resolved.absolute,
              path,
              startLine: startLine ?? 1,
              maxLines: lines,
              checkLeaf: true,
            })),
          };
        }),
      ),

    writeFile: ({ path, content, expectedSha256 }: typeof writeFileInput.Type) =>
      guardedChange(
        path,
        Effect.gen(function* () {
          const resolved = yield* resolveProjectPath(root, path, "new-or-file");
          const create = Effect.map(
            createTextFileEffect({ absolute: resolved.absolute, path: path, text: content }),
            (created) => ({ path, created: true, ...created }),
          );
          const replace = (expected: string) =>
            Effect.gen(function* () {
              yield* Effect.fromOption(Option.fromNullishOr(resolved.stats), () =>
                PathRejected.make({ path, reason: "not_found" }),
              );
              // The values hidden behind placeholders the model wrote are put back.
              const restored = readTextFileEffect({ absolute: resolved.absolute, path: path }).pipe(
                Effect.filterOrFail(
                  (file) => file.sha256 === expected,
                  () =>
                    TextFileRejected.make({
                      path,
                      reason: TextFileRejectedReason.cases.changed.make({}),
                    }),
                ),
                Effect.flatMap((file) =>
                  keepingHidden({
                    path,
                    current: file.text,
                    find: null,
                    replacement: content,
                    replaceAll: false,
                  }),
                ),
                Effect.map((edited) => edited.text),
              );
              const text = yield* mentionsHidden(content) ? restored : Effect.succeed(content);
              const replaced = yield* replaceTextFileEffect({
                absolute: resolved.absolute,
                path: path,
                expectedSha256: expected,
                text,
              });
              return { path, created: false, ...replaced };
            });
          return yield* Option.match(Option.fromNullishOr(expectedSha256), {
            onNone: () => create,
            onSome: replace,
          });
        }),
      ),

    editFile: ({
      path,
      oldText,
      newText,
      replaceAll = false,
      expectedSha256,
    }: typeof editFileInput.Type) =>
      guardedChange(
        path,
        Effect.gen(function* () {
          const resolved = yield* resolveProjectPath(root, path, "file");
          const file = yield* readTextFileEffect({ absolute: resolved.absolute, path: path }).pipe(
            Effect.filterOrFail(
              (read) => expectedSha256 === undefined || expectedSha256 === read.sha256,
              () =>
                TextFileRejected.make({
                  path,
                  reason: TextFileRejectedReason.cases.changed.make({}),
                }),
            ),
          );
          const crlf = file.text.includes("\r\n") && !oldText.includes("\r\n");
          const find = crlf ? oldText.replaceAll("\n", "\r\n") : oldText;
          const replacement = crlf ? newText.replaceAll("\n", "\r\n") : newText;
          const edit = { path, current: file.text, find, replacement, replaceAll };
          const edited = yield* mentionsHidden(oldText) ? keepingHidden(edit) : replaced(edit);
          const written = yield* replaceTextFileEffect({
            absolute: resolved.absolute,
            path: path,
            expectedSha256: file.sha256,
            text: edited.text,
          });
          return { path, replacements: edited.replacements, ...written };
        }),
      ),

    deleteFile: ({ path, expectedSha256 }: typeof deleteFileInput.Type) =>
      guardedChange(
        path,
        Effect.gen(function* () {
          const resolved = yield* resolveProjectPath(root, path, "file");
          const removed = yield* deleteTextFileEffect({
            absolute: resolved.absolute,
            path: path,
            expectedSha256: expectedSha256,
          });
          return { path, deleted: true, ...removed };
        }),
      ),
  });

  return {
    /**
     * File tools for one project (R04). Reads, searches, creation, edits and deletion inside the
     * project run without approval; `.git`, links and credential files are refused. They run on
     * the loop's fiber, so their spans join the run's trace.
     */
    runToolsFor: (project: Project) => {
      const calls = callsFor(project.root);
      return [
        runTool({ ...listFiles, handler: calls.listFiles }),
        runTool({ ...searchFiles, handler: calls.searchFiles }),
        runTool({ ...readFile, handler: calls.readFile }),
        runTool({ ...writeFile, handler: calls.writeFile }),
        runTool({ ...editFile, handler: calls.editFile }),
        runTool({ ...deleteFile, lazy: true, handler: calls.deleteFile }),
      ];
    },
  };
});

/** Project file tools. Keeps recent listing snapshots so paging stays consistent across requests. */
export class FileTools extends Context.Service<FileTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/files/FileTools",
) {
  static readonly layer = Layer.effect(FileTools, make).pipe(Layer.provide(SecretRedactor.layer));
}
