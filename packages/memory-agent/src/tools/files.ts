import { Cause } from "effect";
import { HashSet } from "effect";
import { isTruthy } from "../truthy.ts";
import { path as platformPath, posix } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { toolDefinition } from "@tanstack/ai";
import { MutableHashMap, Option, Context, Effect, Fiber, Result, Layer, Schema } from "effect";
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
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { mentionsHidden, replaceKeepingHidden } from "../secrets/restore.ts";
import { type RunTrace } from "../runtime/run-trace.ts";
import { guardedWith } from "./failure.ts";
import { toToolSchema } from "./schema.ts";

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

export const listPageSize = 500;

/** Search candidates kept per snapshot and query, so later pages do not ask Git again. */
const candidateCacheSize = 32;
const make = Effect.gen(function* () {
  const redactor = yield* SecretRedactor;
  const snapshots = yield* createSnapshots();

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
    if (Result.isSuccess(replaced)) return replaced.success;
    const failure = replaced.failure;
    switch (failure._tag) {
      case "no_match":
        return yield* new Cause.UnknownError(
          new Error(`no_match: ${options.path}. oldText does not occur; read the file again.`),
        );
      case "ambiguous":
        return yield* new Cause.UnknownError(
          new Error(
            `ambiguous_match: ${options.path}. oldText occurs ${failure.occurrences} times; add surrounding lines or pass replaceAll.`,
          ),
        );
      case "cuts_hidden":
        return yield* new Cause.UnknownError(
          new Error(
            `hidden_value_split: ${options.path}. oldText starts or ends inside a [redacted:…] placeholder; include the whole placeholder.`,
          ),
        );
    }
  });
  const candidateCache = MutableHashMap.empty<string, HashSet.HashSet<string> | null>();
  const readPage = createTextPageReader();

  /**
   * In a Git work tree, the files that can match at all; null means search every file. The first
   * page starts `git grep` together with the listing and owns its Fiber as `started`.
   */
  const candidatesFor = Effect.fnUntraced(function* (
    view: Snapshot,
    query: string,
    caseSensitive: boolean,
    started?: Fiber.Fiber<HashSet.HashSet<string> | null>,
  ) {
    if (view.source !== "git") {
      if (started !== undefined) yield* Fiber.interrupt(started);
      return null;
    }
    const key = `${view.id}\u0000${caseSensitive}\u0000${query}`;
    const cached = Option.getOrUndefined(MutableHashMap.get(candidateCache, key));
    if (cached !== undefined) return cached;
    const candidates =
      started === undefined
        ? yield* gitGrepFilesEffect({
            root: view.root,
            directory: view.directory,
            query,
            caseSensitive,
          })
        : yield* Fiber.join(started);
    MutableHashMap.set(candidateCache, key, candidates);
    for (const old of MutableHashMap.keys(candidateCache)) {
      if (MutableHashMap.size(candidateCache) <= candidateCacheSize) break;
      MutableHashMap.remove(candidateCache, old);
    }
    return candidates;
  });

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

  return {
    /**
     * File tools for one project (R04). Reads, searches, creation, edits and deletion inside the
     * project run without approval; `.git`, links and credential files are refused. `caller` is
     * the run's context, so the tools' spans join the run's trace; tests leave it out.
     */
    forProject(project: Project, caller?: RunTrace) {
      const { root } = project;
      const guarded = guardedWith(caller);

      const listFiles = toolDefinition({
        name: "list_files",
        description:
          "List files in the project, recursively, honouring .gitignore in Git projects. Page with snapshot + nextOffset; a snapshot is a fixed view taken on the first page.",
        inputSchema: toToolSchema(listFilesInput),
      }).server(({ directory, glob, snapshot, offset }, context) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(
          directory ?? ".",
          () =>
            Effect.gen(function* () {
              const view = !isTruthy(snapshot)
                ? yield* snapshotFor(root, directory, glob)
                : snapshots.get(snapshot, root);
              if (!isTruthy(view))
                return yield* new Cause.UnknownError(
                  new Error("snapshot_expired: start again without snapshot and offset."),
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
          context?.abortSignal,
        ),
      );

      const searchFiles = toolDefinition({
        name: "search_files",
        description:
          "Find literal text across project files and return matching lines with line numbers. Narrow with directory and glob. Page with nextCursor; skipped files are listed, so an empty result only covers the files actually searched.",
        inputSchema: toToolSchema(searchFilesInput),
      }).server(({ query, directory, glob, caseSensitive = true, cursor }, context) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(
          directory ?? ".",
          () =>
            Effect.gen(function* () {
              const position = isTruthy(cursor) ? decodeSearchCursor(cursor) : undefined;
              if (
                isTruthy(cursor) &&
                (position?.query !== query || position.caseSensitive !== caseSensitive)
              )
                return yield* new Cause.UnknownError(
                  new Error(
                    "invalid_cursor: pass the same query and caseSensitive as the first page.",
                  ),
                );
              // On the first page, ask Git for candidate files while the listing is being taken.
              const started =
                position !== undefined
                  ? undefined
                  : yield* Effect.forkChild(
                      gitGrepFilesEffect({
                        root,
                        directory: (yield* resolveProjectPath(root, directory ?? ".", "directory"))
                          .relative,
                        query,
                        caseSensitive,
                      }),
                    );
              const view =
                position !== undefined
                  ? snapshots.get(position.snapshot, root)
                  : yield* snapshotFor(root, directory, glob);
              if (!isTruthy(view))
                return yield* new Cause.UnknownError(
                  new Error("snapshot_expired: start the search again without cursor."),
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
                  let checked = Option.getOrUndefined(MutableHashMap.get(directories, directory));
                  if (!isTruthy(checked)) {
                    checked = yield* resolveProjectPath(root, directory, "directory").pipe(
                      Effect.as(Result.succeed(undefined)),
                      Effect.catchTag("PathRejected", (error) =>
                        Effect.succeed(Result.fail(error)),
                      ),
                    );
                    MutableHashMap.set(directories, directory, checked);
                  }
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
                start: position ?? { file: 0, line: 0 },
                candidates,
              });
              return {
                filesInView: view.paths.length,
                matches: page.matches,
                skipped: page.skipped,
                nextCursor: isTruthy(page.next)
                  ? encodeSearchCursor({ snapshot: view.id, query, caseSensitive, ...page.next })
                  : null,
                complete: page.next === null && page.skipped.length === 0,
              };
            }),
          context?.abortSignal,
        ),
      );

      const readFile = toolDefinition({
        name: "read_file",
        description:
          "Read a project text file by line range. Returns the exact content (line endings kept) and the file's sha256, which write_file, edit_file and delete_file use to avoid overwriting newer changes.",
        inputSchema: toToolSchema(readFileInput),
      }).server(({ path, startLine, maxLines }, context) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(
          path,
          () =>
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
          context?.abortSignal,
        ),
      );

      const writeFile = toolDefinition({
        name: "write_file",
        description:
          "Create a project file, or replace a whole existing file when expectedSha256 from read_file is given. Missing parent directories are created. Prefer edit_file for small changes.",
        inputSchema: toToolSchema(writeFileInput),
      }).server(({ path, content, expectedSha256 }) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(path, () =>
          Effect.gen(function* () {
            const resolved = yield* resolveProjectPath(root, path, "new-or-file");
            if (expectedSha256 === undefined) {
              const created = yield* createTextFileEffect({
                absolute: resolved.absolute,
                path: path,
                text: content,
              });
              return { path, created: true, ...created };
            }
            if (!(resolved.stats !== undefined))
              return yield* PathRejected.make({ path, reason: "not_found" });
            let text = content;
            if (mentionsHidden(content)) {
              const file = yield* readTextFileEffect({ absolute: resolved.absolute, path: path });
              if (file.sha256 !== expectedSha256)
                return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
              text = (yield* keepingHidden({
                path,
                current: file.text,
                find: null,
                replacement: content,
                replaceAll: false,
              })).text;
            }
            const replaced = yield* replaceTextFileEffect({
              absolute: resolved.absolute,
              path: path,
              expectedSha256: expectedSha256,
              text,
            });
            return { path, created: false, ...replaced };
          }),
        ),
      );

      const editFile = toolDefinition({
        name: "edit_file",
        description:
          "Replace exact text in a project file. oldText must match once (or pass replaceAll). CRLF files accept oldText written with plain newlines.",
        inputSchema: toToolSchema(editFileInput),
      }).server(({ path, oldText, newText, replaceAll = false, expectedSha256 }) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(path, () =>
          Effect.gen(function* () {
            const resolved = yield* resolveProjectPath(root, path, "file");
            const file = yield* readTextFileEffect({ absolute: resolved.absolute, path: path });
            if (expectedSha256 !== undefined && expectedSha256 !== file.sha256)
              return yield* TextFileRejected.make({ path, reason: { _tag: "changed" } });
            const crlf = file.text.includes("\r\n") && !oldText.includes("\r\n");
            const find = crlf ? oldText.replaceAll("\n", "\r\n") : oldText;
            const replacement = crlf ? newText.replaceAll("\n", "\r\n") : newText;
            if (mentionsHidden(oldText)) {
              const edited = yield* keepingHidden({
                path,
                current: file.text,
                find,
                replacement,
                replaceAll,
              });
              const written = yield* replaceTextFileEffect({
                absolute: resolved.absolute,
                path: path,
                expectedSha256: file.sha256,
                text: edited.text,
              });
              return { path, replacements: edited.replacements, ...written };
            }
            const occurrences = file.text.split(find).length - 1;
            if (occurrences === 0)
              return yield* new Cause.UnknownError(
                new Error(`no_match: ${path}. oldText does not occur; read the file again.`),
              );
            if (occurrences > 1 && !replaceAll)
              return yield* new Cause.UnknownError(
                new Error(
                  `ambiguous_match: ${path}. oldText occurs ${occurrences} times; add surrounding lines or pass replaceAll.`,
                ),
              );
            const text = file.text.replaceAll(find, () => replacement);
            const written = yield* replaceTextFileEffect({
              absolute: resolved.absolute,
              path: path,
              expectedSha256: file.sha256,
              text: text,
            });
            return { path, replacements: occurrences, ...written };
          }),
        ),
      );

      const deleteFile = toolDefinition({
        name: "delete_file",
        description:
          "Delete one project file whose content still matches expectedSha256 from read_file. Directories are not deleted.",
        inputSchema: toToolSchema(deleteFileInput),
      }).server(({ path, expectedSha256 }) =>
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        guarded(path, () =>
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
      );

      return [listFiles, searchFiles, readFile, writeFile, editFile, deleteFile] as const;
    },
  };
});

/** Project file tools. Keeps recent listing snapshots so paging stays consistent across requests. */
export class FileTools extends Context.Service<FileTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/files/FileTools",
) {
  static readonly layer = Layer.effect(FileTools, make).pipe(Layer.provide(SecretRedactor.layer));
}
