import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { toolDefinition } from "@tanstack/ai";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { gitGrepFiles } from "../files/git-grep.ts";
import { listProjectFiles, createSnapshots, type Snapshot } from "../files/listing.ts";
import { PathRejected, resolveProjectPath } from "../files/paths.ts";
import { decodeSearchCursor, encodeSearchCursor, searchTextFiles } from "../files/search.ts";
import {
  createTextFile,
  deleteTextFile,
  linePageOf,
  readFileBytes,
  readTextFile,
  splitLines,
  replaceTextFile,
  TextFileRejected,
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { guarded, orThrow } from "./failure.ts";
import { toToolSchema } from "./schema.ts";

export const fileToolNames = [
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

const directoryField = Schema.optional(
  Schema.String.annotations({
    description: 'Project-relative directory to look in. Defaults to the project root (".").',
  }),
);
const globField = Schema.optional(
  Schema.String.annotations({
    description: 'Glob relative to the directory, like "**/*.ts" or "src/*.md".',
  }),
);
const sha256Field = Schema.String.annotations({
  description: "sha256 returned by the read that this change is based on.",
});

const listFilesInput = Schema.Struct({
  directory: directoryField,
  glob: globField,
  snapshot: Schema.optional(
    Schema.String.annotations({ description: "snapshot from the previous page when paging." }),
  ),
  offset: Schema.optional(
    Schema.Int.annotations({ description: "nextOffset from the previous page when paging." }),
  ),
});

const searchFilesInput = Schema.Struct({
  query: Schema.NonEmptyString.annotations({
    description: "Literal text to find (not a regular expression).",
  }),
  directory: directoryField,
  glob: globField,
  caseSensitive: Schema.optional(Schema.Boolean.annotations({ description: "Defaults to true." })),
  cursor: Schema.optional(
    Schema.String.annotations({ description: "nextCursor from the previous page when paging." }),
  ),
});

const readFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Project-relative file path." }),
  startLine: Schema.optional(Schema.Int.annotations({ description: "1-based. Defaults to 1." })),
  maxLines: Schema.optional(
    Schema.Int.annotations({ description: "Lines per page, up to 2000. Defaults to 400." }),
  ),
});

const writeFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Project-relative file path." }),
  content: Schema.String.annotations({ description: "The complete new file content." }),
  expectedSha256: Schema.optional(
    sha256Field.annotations({
      description: "Required to replace an existing file: the sha256 from read_file.",
    }),
  ),
});

const editFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Project-relative file path." }),
  oldText: Schema.NonEmptyString.annotations({
    description: "Exact text to replace, including indentation. Must occur exactly once.",
  }),
  newText: Schema.String.annotations({ description: "Replacement text." }),
  replaceAll: Schema.optional(
    Schema.Boolean.annotations({ description: "Replace every occurrence instead of exactly one." }),
  ),
  expectedSha256: Schema.optional(sha256Field),
});

const deleteFileInput = Schema.Struct({
  path: Schema.String.annotations({ description: "Project-relative file path." }),
  expectedSha256: sha256Field,
});

export const listPageSize = 500;

/** Search candidates kept per snapshot and query, so later pages do not ask Git again. */
const candidateCacheSize = 32;
/** Files whose read pages are kept between calls, checked against the file's current stat. */
const readCacheSize = 8;

interface CachedRead {
  /** Size, change time and inode at the read; any difference means the file changed. */
  readonly stamp: string;
  readonly sha256: string;
  readonly lines: readonly string[];
}

const make = Effect.gen(function* () {
  const snapshots = yield* createSnapshots();
  const candidateCache = new Map<string, Promise<ReadonlySet<string> | null>>();
  const readCache = new Map<string, CachedRead>();

  /**
   * In a Git work tree, the files that can match at all; null means search every file. The first
   * page starts `git grep` together with the listing and hands it over as `started`.
   */
  const candidatesFor = (
    view: Snapshot,
    query: string,
    caseSensitive: boolean,
    started?: Promise<ReadonlySet<string> | null>,
  ) => {
    if (view.source !== "git") return Promise.resolve(null);
    const key = `${view.id}\u0000${caseSensitive}\u0000${query}`;
    const cached = candidateCache.get(key);
    if (cached) return cached;
    const pending = started ?? gitGrepFiles(view.root, view.directory, query, caseSensitive);
    candidateCache.set(key, pending);
    for (const old of candidateCache.keys()) {
      if (candidateCache.size <= candidateCacheSize) break;
      candidateCache.delete(old);
    }
    return pending;
  };

  /**
   * A text file split into lines, reusing the last read while size, change time (ns) and inode are
   * unchanged, so paging through a big file does not re-read and re-hash it on every page.
   */
  const readLines = async (absolute: string, path: string) => {
    const stats = await lstat(absolute, { bigint: true });
    const stamp = `${stats.size}:${stats.ctimeNs}:${stats.mtimeNs}:${stats.ino}`;
    const cached = readCache.get(absolute);
    if (cached?.stamp === stamp) return cached;
    const file = await readTextFile(absolute, path);
    const entry: CachedRead = { stamp, sha256: file.sha256, lines: splitLines(file.text) };
    readCache.delete(absolute);
    readCache.set(absolute, entry);
    for (const old of readCache.keys()) {
      if (readCache.size <= readCacheSize) break;
      readCache.delete(old);
    }
    return entry;
  };

  const snapshotFor = async (
    root: string,
    directory: string | undefined,
    glob: string | undefined,
  ) => {
    const resolved = orThrow(resolveProjectPath(root, directory ?? ".", "directory"));
    return snapshots.add(
      root,
      resolved.relative,
      glob,
      await listProjectFiles(root, resolved.relative, glob),
    );
  };

  return {
    /**
     * File tools for one project (R04). Reads, searches, creation, edits and deletion inside the
     * project run without approval; `.git`, links and credential files are refused.
     */
    forProject(project: Project) {
      const { root } = project;

      const listFiles = toolDefinition({
        name: "list_files",
        description:
          "List files in the project, recursively, honouring .gitignore in Git projects. Page with snapshot + nextOffset; a snapshot is a fixed view taken on the first page.",
        inputSchema: toToolSchema(listFilesInput),
      }).server(({ directory, glob, snapshot, offset }) =>
        guarded(directory ?? ".", async () => {
          const view = !snapshot
            ? await snapshotFor(root, directory, glob)
            : snapshots.get(snapshot, root);
          if (!view) throw new Error("snapshot_expired: start again without snapshot and offset.");
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
      );

      const searchFiles = toolDefinition({
        name: "search_files",
        description:
          "Find literal text across project files and return matching lines with line numbers. Narrow with directory and glob. Page with nextCursor; skipped files are listed, so an empty result only covers the files actually searched.",
        inputSchema: toToolSchema(searchFilesInput),
      }).server(({ query, directory, glob, caseSensitive = true, cursor }) =>
        guarded(directory ?? ".", async () => {
          const position = cursor ? decodeSearchCursor(cursor) : undefined;
          if (cursor && (position?.query !== query || position.caseSensitive !== caseSensitive))
            throw new Error(
              "invalid_cursor: pass the same query and caseSensitive as the first page.",
            );
          // On the first page, ask Git for candidate files while the listing is being taken.
          const started = position
            ? undefined
            : gitGrepFiles(
                root,
                orThrow(resolveProjectPath(root, directory ?? ".", "directory")).relative,
                query,
                caseSensitive,
              );
          const view = position
            ? snapshots.get(position.snapshot, root)
            : await snapshotFor(root, directory, glob);
          if (!view) throw new Error("snapshot_expired: start the search again without cursor.");

          // Each directory is checked once per page (no links, still inside the project); the file
          // itself is checked on the opened handle, so thousands of files do not mean thousands of
          // synchronous path walks.
          const directories = new Map<string, Either.Either<unknown, PathRejected>>();
          const page = await searchTextFiles(
            view.paths,
            async (path) => {
              const directory = posix.dirname(path);
              let checked = directories.get(directory);
              if (!checked) {
                checked = resolveProjectPath(root, directory, "directory");
                directories.set(directory, checked);
              }
              Either.getOrElse(checked, (rejection) => {
                throw new PathRejected({ path, reason: rejection.reason });
              });
              return (await readFileBytes(join(root, path), path, true)).bytes;
            },
            query,
            caseSensitive,
            position ?? { file: 0, line: 0 },
            { candidates: await candidatesFor(view, query, caseSensitive, started) },
          );
          return {
            filesInView: view.paths.length,
            matches: page.matches,
            skipped: page.skipped,
            nextCursor: page.next
              ? encodeSearchCursor({ snapshot: view.id, query, caseSensitive, ...page.next })
              : null,
            complete: page.next === null && page.skipped.length === 0,
          };
        }),
      );

      const readFile = toolDefinition({
        name: "read_file",
        description:
          "Read a project text file by line range. Returns the exact content (line endings kept) and the file's sha256, which write_file, edit_file and delete_file use to avoid overwriting newer changes.",
        inputSchema: toToolSchema(readFileInput),
      }).server(({ path, startLine, maxLines }) =>
        guarded(path, async () => {
          const resolved = orThrow(resolveProjectPath(root, path, "file"));
          const file = await readLines(resolved.absolute, path);
          const lines = Math.min(Math.max(1, maxLines ?? 400), 2000);
          return { path, sha256: file.sha256, ...linePageOf(file.lines, startLine ?? 1, lines) };
        }),
      );

      const writeFile = toolDefinition({
        name: "write_file",
        description:
          "Create a project file, or replace a whole existing file when expectedSha256 from read_file is given. Missing parent directories are created. Prefer edit_file for small changes.",
        inputSchema: toToolSchema(writeFileInput),
      }).server(({ path, content, expectedSha256 }) =>
        guarded(path, async () => {
          const resolved = orThrow(resolveProjectPath(root, path, "new-or-file"));
          if (expectedSha256 === undefined) {
            const created = await createTextFile(resolved.absolute, path, content);
            return { path, created: true, ...created };
          }
          if (!resolved.stats) throw new PathRejected({ path, reason: "not_found" });
          const replaced = await replaceTextFile(resolved.absolute, path, expectedSha256, content);
          return { path, created: false, ...replaced };
        }),
      );

      const editFile = toolDefinition({
        name: "edit_file",
        description:
          "Replace exact text in a project file. oldText must match once (or pass replaceAll). CRLF files accept oldText written with plain newlines.",
        inputSchema: toToolSchema(editFileInput),
      }).server(({ path, oldText, newText, replaceAll = false, expectedSha256 }) =>
        guarded(path, async () => {
          const resolved = orThrow(resolveProjectPath(root, path, "file"));
          const file = await readTextFile(resolved.absolute, path);
          if (expectedSha256 !== undefined && expectedSha256 !== file.sha256)
            throw new TextFileRejected({ path, reason: "changed" });
          const crlf = file.text.includes("\r\n") && !oldText.includes("\r\n");
          const find = crlf ? oldText.replaceAll("\n", "\r\n") : oldText;
          const replacement = crlf ? newText.replaceAll("\n", "\r\n") : newText;
          const occurrences = file.text.split(find).length - 1;
          if (occurrences === 0)
            throw new Error(`no_match: ${path}. oldText does not occur; read the file again.`);
          if (occurrences > 1 && !replaceAll)
            throw new Error(
              `ambiguous_match: ${path}. oldText occurs ${occurrences} times; add surrounding lines or pass replaceAll.`,
            );
          const text = file.text.replaceAll(find, () => replacement);
          const written = await replaceTextFile(resolved.absolute, path, file.sha256, text);
          return { path, replacements: occurrences, ...written };
        }),
      );

      const deleteFile = toolDefinition({
        name: "delete_file",
        description:
          "Delete one project file whose content still matches expectedSha256 from read_file. Directories are not deleted.",
        inputSchema: toToolSchema(deleteFileInput),
      }).server(({ path, expectedSha256 }) =>
        guarded(path, async () => {
          const resolved = orThrow(resolveProjectPath(root, path, "file"));
          const removed = await deleteTextFile(resolved.absolute, path, expectedSha256);
          return { path, deleted: true, ...removed };
        }),
      );

      return [listFiles, searchFiles, readFile, writeFile, editFile, deleteFile] as const;
    },
  };
});

/** Project file tools. Keeps recent listing snapshots so paging stays consistent across requests. */
export class FileTools extends Context.Tag("memory-agent/FileTools")<
  FileTools,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(FileTools, make);
}
