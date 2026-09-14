import { toolDefinition } from "@tanstack/ai";
import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import { listProjectFiles, Snapshots } from "../files/listing.ts";
import { PathRejected, resolveProjectPath } from "../files/paths.ts";
import {
  createTextFile,
  deleteTextFile,
  linePage,
  readTextFile,
  replaceTextFile,
  TextFileRejected,
} from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { toToolSchema } from "./schema.ts";

export const fileToolNames = [
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

const refusalHints = new Map<string, string>([
  ["invalid_path", "Use a project-relative path with / separators and no . or .. segments."],
  ["credential", "Credential files are never read or changed, even with approval."],
  ["git_internal", "Files inside .git are not changed directly; run git through the shell."],
  ["inside_project", "The path is inside the project; use the project file tools instead."],
  ["symlink", "Links are not followed; use the real path."],
  ["hard_link", "Hard-linked files are not read or changed."],
  ["not_found", "Nothing exists at that path."],
  ["not_file", "The path is not a regular file."],
  ["not_directory", "The path is not a directory."],
  ["too_large", "Files over 2 MiB are not read by the file tools."],
  ["binary", "The file contains NUL bytes and is not text."],
  ["invalid_utf8", "The file is not valid UTF-8 text."],
  ["changed", "The file changed since it was read. Read it again before changing it."],
  ["exists", "A file already exists there. Read it and pass its sha256 to replace it."],
]);

/** Turns a refusal into the error message the model sees. Host errors lose their absolute paths. */
export function toolFailure(error: Error, path: string): Error {
  if (error instanceof PathRejected || error instanceof TextFileRejected)
    return new Error(`${error.reason}: ${path}. ${refusalHints.get(error.reason) ?? ""}`.trim());
  // Tool-authored messages already follow the `reason: path. hint` form.
  if (/^[a-z_]+: /.test(error.message) && !("code" in error)) return error;
  const code = "code" in error && Schema.is(Schema.String)(error.code) ? error.code : "unknown";
  return new Error(`io_error: ${path} (${code})`);
}

/** Runs one file operation, rethrowing any failure as a model-facing message. */
async function guarded<A>(path: string, operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch (error) {
    throw toolFailure(error instanceof Error ? error : new Error(String(error)), path);
  }
}

const orThrow = <A>(result: Either.Either<A, PathRejected>) =>
  Either.getOrElse(result, (rejection) => {
    throw rejection;
  });

const Cursor = Schema.parseJson(
  Schema.Struct({
    snapshot: Schema.String,
    query: Schema.String,
    caseSensitive: Schema.Boolean,
    file: Schema.Number,
    line: Schema.Number,
  }),
);
const encodeCursor = (cursor: typeof Cursor.Type) =>
  Buffer.from(Schema.encodeSync(Cursor)(cursor)).toString("base64url");
const decodeCursor = (text: string) =>
  Schema.decodeUnknownOption(Cursor)(Buffer.from(text, "base64url").toString("utf8"));

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

const listPageSize = 500;
const searchMatchLimit = 100;
const searchPageCharacters = 12_000;
const snippetCharacters = 300;

function snippet(line: string, index: number) {
  if (line.length <= snippetCharacters) return line;
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + snippetCharacters)}…`;
}

const make = Effect.sync(() => {
  const snapshots = new Snapshots();

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
          const view =
            snapshot === undefined
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
          let view;
          let fileIndex = 0;
          let lineIndex = 0;
          if (cursor === undefined) view = await snapshotFor(root, directory, glob);
          else {
            const position = Option.getOrUndefined(decodeCursor(cursor));
            if (!position || position.query !== query || position.caseSensitive !== caseSensitive)
              throw new Error(
                "invalid_cursor: pass the same query and caseSensitive as the first page.",
              );
            view = snapshots.get(position.snapshot, root);
            fileIndex = position.file;
            lineIndex = position.line;
          }
          if (!view) throw new Error("snapshot_expired: start the search again without cursor.");

          const needle = caseSensitive ? query : query.toLowerCase();
          const matches: Array<{ path: string; line: number; text: string }> = [];
          const skipped: Array<{ path: string; reason: string }> = [];
          let characters = 0;
          let nextCursor: string | null = null;

          files: for (; fileIndex < view.paths.length; fileIndex++, lineIndex = 0) {
            const path = view.paths[fileIndex]!;
            let text: string;
            try {
              const resolved = orThrow(resolveProjectPath(root, path, "file"));
              text = (await readTextFile(resolved.absolute, path)).text;
            } catch (error) {
              const reason =
                error instanceof PathRejected || error instanceof TextFileRejected
                  ? error.reason
                  : "unreadable";
              if (reason !== "not_found") skipped.push({ path, reason });
              continue;
            }
            const lines = text.split(/\r?\n/);
            for (; lineIndex < lines.length; lineIndex++) {
              const line = lines[lineIndex]!;
              const index = (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
              if (index < 0) continue;
              const match = { path, line: lineIndex + 1, text: snippet(line, index) };
              matches.push(match);
              characters += match.path.length + match.text.length + 32;
              if (matches.length >= searchMatchLimit || characters >= searchPageCharacters) {
                const atEnd = lineIndex + 1 >= lines.length && fileIndex + 1 >= view.paths.length;
                if (!atEnd)
                  nextCursor = encodeCursor({
                    snapshot: view.id,
                    query,
                    caseSensitive,
                    file: lineIndex + 1 >= lines.length ? fileIndex + 1 : fileIndex,
                    line: lineIndex + 1 >= lines.length ? 0 : lineIndex + 1,
                  });
                break files;
              }
            }
          }

          return {
            filesInView: view.paths.length,
            matches,
            skipped,
            nextCursor,
            complete: nextCursor === null && skipped.length === 0,
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
          const file = await readTextFile(resolved.absolute, path);
          const lines = Math.min(Math.max(1, maxLines ?? 400), 2000);
          return { path, sha256: file.sha256, ...linePage(file.text, startLine ?? 1, lines) };
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
