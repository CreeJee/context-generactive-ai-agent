import { Result, Function as EffectFunction } from "effect";
import {
  Cache,
  Data,
  Effect,
  HashSet,
  MutableHashSet,
  Option,
  Predicate,
  Schema,
  Scope,
} from "effect";
import { PathRejected } from "./paths.ts";
import {
  decodeTextEffect,
  type LinePage,
  TextFileIoFailed,
  TextFileRejected,
  textFileRejectedReasonName,
} from "./text.ts";

export interface SearchMatch {
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** The line, shortened around the match when long. */
  readonly text: string;
}

export interface SearchSkip {
  readonly path: string;
  readonly reason: string;
}

/** Where a search stopped: the file index in the snapshot and the 0-based line inside it. */
export interface SearchPosition {
  readonly file: number;
  readonly line: number;
}

export interface SearchPage {
  readonly matches: readonly SearchMatch[];
  readonly skipped: readonly SearchSkip[];
  readonly next: SearchPosition | null;
}

const matchLimit = 100;
const pageCharacters = 12_000;
/** Files opened per page, so a search over a huge tree still answers in bounded time. */
const filesPerPage = 2_000;
const snippetCharacters = 300;
/** Files read ahead at once; results are still taken in order. */
const readAhead = 4;

function snippet(line: string, index: number) {
  if (line.length <= snippetCharacters) return line;
  const start = Math.max(0, index - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + snippetCharacters)}…`;
}

type FileRead = Data.TaggedEnum<{
  bytes: { readonly bytes: Uint8Array };
  skipped: { readonly reason: string };
  gone: {};
}>;
const FileRead = Data.taggedEnum<FileRead>();

export interface SearchOptions {
  /**
   * Files known to contain the query (from `git grep`); other files are not opened. Null searches
   * every file.
   */
  readonly candidates?: HashSet.HashSet<string> | null;
}

/** Matches of `needle` in `text`, one per line, from 0-based line `fromLine`. */
function* lineMatches(text: string, needle: string, caseSensitive: boolean, fromLine: number) {
  const haystack = caseSensitive ? text : text.toLowerCase();
  if (haystack.length !== text.length) {
    // Lowercasing changed the length (rare letters), so positions would not line up: go by line.
    const lines = text.split("\n");
    for (let line = fromLine; line < lines.length; line++) {
      const content = lines[line]!.replace(/\r$/, "");
      const column = content.toLowerCase().indexOf(needle);
      if (column >= 0) yield { line, content, column };
    }
    return;
  }
  let line = 0;
  let lineStart = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    // Advance the line counter to the match.
    let newline = text.indexOf("\n", lineStart);
    while (newline >= 0 && newline < index) {
      line++;
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
    }
    const lineEnd = newline < 0 ? text.length : newline;
    if (line >= fromLine) {
      const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
      yield { line, content, column: index - lineStart };
    }
    if (newline < 0) return;
    // One match per line: continue on the next line.
    line++;
    lineStart = newline + 1;
    index = haystack.indexOf(needle, lineStart);
  }
}

/**
 * One page of a literal line search over a fixed list of files, starting at `start`. `readBytes`
 * resolves and reads one file; its {@link PathRejected} or {@link TextFileRejected} failures are
 * reported as skipped (a file that vanished is dropped silently).
 *
 * A file whose bytes do not contain a case-sensitive query cannot match, so it is not decoded, and
 * a binary or non-UTF-8 file is only reported as skipped when it might have matched.
 */
type ReadFailure =
  | PathRejected
  | TextFileRejected
  | TextFileIoFailed
  | import("effect/PlatformError").PlatformError;

export interface SearchTextInput<R = never> extends SearchOptions {
  readonly paths: readonly string[];
  readonly readBytes: (path: string) => Effect.Effect<Uint8Array, ReadFailure, R>;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly start: SearchPosition;
  readonly readPage?: (path: string, startLine: number) => Effect.Effect<LinePage, ReadFailure, R>;
}

export const searchTextFilesEffect = Effect.fn("searchTextFiles")(function* <R>(
  input: SearchTextInput<R>,
): Effect.fn.Return<SearchPage, never, R | Scope.Scope> {
  if (input.readPage !== undefined && !input.query.includes("\n"))
    return yield* searchPagedFiles(input, input.readPage);
  const { paths, readBytes, query, caseSensitive, start } = input;
  const needle = caseSensitive ? query : query.toLowerCase();
  const needleBytes = Buffer.from(query, "utf8");
  const candidates = input.candidates ?? null;
  const matches: SearchMatch[] = [];
  const skipped: SearchSkip[] = [];
  let characters = 0;
  let opened = 0;

  const reads = yield* Cache.make({
    capacity: readAhead + 1,
    lookup: (file: number) =>
      readBytes(paths[file]!).pipe(
        Effect.map((bytes): FileRead => FileRead.bytes({ bytes })),
        Effect.catchTags({
          PathRejected: (error) =>
            Effect.succeed<FileRead>(
              error.reason === "not_found"
                ? FileRead.gone()
                : FileRead.skipped({ reason: error.reason }),
            ),
          TextFileRejected: (error) =>
            Effect.succeed<FileRead>(
              FileRead.skipped({ reason: textFileRejectedReasonName(error.reason) }),
            ),
          PlatformError: (error) =>
            Effect.succeed<FileRead>(
              Predicate.isTagged(error.reason, "NotFound")
                ? FileRead.gone()
                : FileRead.skipped({ reason: "unreadable" }),
            ),
          TextFileIoFailed: (error) =>
            Effect.succeed<FileRead>(
              error.reason.code === "ENOENT"
                ? FileRead.gone()
                : FileRead.skipped({ reason: "unreadable" }),
            ),
        }),
      ),
  });
  const started = MutableHashSet.empty<number>();
  // The files this page may open, in order: every file, or only the candidates.
  const order: number[] = [];
  for (let file = start.file; file < paths.length; file++)
    if (candidates === null || HashSet.has(candidates, paths[file]!)) order.push(file);

  for (let position = 0; position < order.length; position++) {
    const file = order[position]!;
    if (opened === filesPerPage) return { matches, skipped, next: { file, line: 0 } };
    opened++;
    // Start the next few reads now, so the disk works while this file is matched.
    for (const ahead of order.slice(position + 1, position + 1 + readAhead)) {
      if (MutableHashSet.has(started, ahead)) continue;
      MutableHashSet.add(started, ahead);
      yield* Effect.forkScoped(Cache.get(reads, ahead));
    }
    const path = paths[file]!;
    const result = yield* Cache.get(reads, file);
    yield* Cache.invalidate(reads, file);
    if (FileRead.$is("gone")(result)) continue;
    if (FileRead.$is("skipped")(result)) {
      skipped.push({ path, reason: result.reason });
      continue;
    }
    if (
      caseSensitive &&
      Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength).indexOf(
        needleBytes,
      ) < 0
    )
      continue;
    const decoded = yield* Effect.result(decodeTextEffect({ bytes: result.bytes, path }));
    if (Result.isFailure(decoded)) {
      skipped.push({ path, reason: textFileRejectedReasonName(decoded.failure.reason) });
      continue;
    }
    const text = decoded.success;
    const fromLine = file === start.file ? start.line : 0;
    for (const found of lineMatches(text, needle, caseSensitive, fromLine)) {
      const match = { path, line: found.line + 1, text: snippet(found.content, found.column) };
      matches.push(match);
      characters += match.path.length + match.text.length + 32;
      if (matches.length < matchLimit && characters < pageCharacters) continue;
      // Lines are counted as split on "\n": one more than the newlines.
      const totalLines = text.split("\n").length;
      const next =
        found.line + 1 < totalLines ? { file, line: found.line + 1 } : { file: file + 1, line: 0 };
      return { matches, skipped, next: next.file < paths.length ? next : null };
    }
  }
  return { matches, skipped, next: null };
}, Effect.scoped);

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.String,
    query: Schema.String,
    caseSensitive: Schema.Boolean,
    file: Schema.Int,
    line: Schema.Int,
  }),
);
export type SearchCursor = typeof Cursor.Type;

/** An opaque continuation token for the model. */
export const encodeSearchCursor = (cursor: SearchCursor) =>
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  Buffer.from(EffectFunction.flow(Schema.encodeResult(Cursor), Result.getOrThrow)(cursor)).toString(
    "base64url",
  );

export const decodeSearchCursor = (text: string) =>
  Option.getOrUndefined(
    Schema.decodeOption(Cursor)(Buffer.from(text, "base64url").toString("utf8")),
  );

/** Validates once per file revision, then reads only the next line range. No speculative handles. */
const searchPagedFiles = Effect.fnUntraced(function* <R>(
  input: SearchTextInput<R>,
  readPage: NonNullable<SearchTextInput<R>["readPage"]>,
): Effect.fn.Return<SearchPage, never, R | Scope.Scope> {
  const matches: SearchMatch[] = [];
  const skipped: SearchSkip[] = [];
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  let characters = 0;
  let opened = 0;
  for (let file = input.start.file; file < input.paths.length; file++) {
    const path = input.paths[file]!;
    if (input.candidates != null && !HashSet.has(input.candidates, path)) continue;
    if (opened++ === filesPerPage) return { matches, skipped, next: { file, line: 0 } };
    let line = file === input.start.file ? input.start.line : 0;
    while (true) {
      const result = yield* Effect.result(readPage(path, line + 1));
      if (Result.isFailure(result)) {
        // Keep the original binary/UTF-8 candidate filtering and skip semantics.
        const fallback = yield* searchTextFilesEffect({
          paths: [path],
          readBytes: input.readBytes,
          query: input.query,
          caseSensitive: input.caseSensitive,
          start: { file: 0, line },
        });
        skipped.push(...fallback.skipped);
        for (const match of fallback.matches) {
          matches.push(match);
          characters += match.path.length + match.text.length + 32;
          if (matches.length >= matchLimit || characters >= pageCharacters)
            return { matches, skipped, next: { file, line: match.line } };
        }
        if (fallback.next !== null)
          return { matches, skipped, next: { file, line: fallback.next.line } };
        break;
      }
      const page = result.success;
      if (page.lineTruncated) {
        // A long line may match beyond the preview; retain the bounded whole-file fallback.
        const fallback = yield* searchTextFilesEffect({
          paths: [path],
          readBytes: input.readBytes,
          query: input.query,
          caseSensitive: input.caseSensitive,
          start: { file: 0, line },
        });
        skipped.push(...fallback.skipped);
        for (const match of fallback.matches) {
          matches.push(match);
          characters += match.path.length + match.text.length + 32;
          if (matches.length >= matchLimit || characters >= pageCharacters)
            return { matches, skipped, next: { file, line: match.line } };
        }
        if (fallback.next !== null)
          return { matches, skipped, next: { file, line: fallback.next.line } };
        break;
      }
      for (const found of lineMatches(page.content, needle, input.caseSensitive, 0)) {
        const match = {
          path,
          line: line + found.line + 1,
          text: snippet(found.content, found.column),
        };
        matches.push(match);
        characters += match.path.length + match.text.length + 32;
        if (matches.length >= matchLimit || characters >= pageCharacters) {
          const next =
            match.line < page.totalLines ? { file, line: match.line } : { file: file + 1, line: 0 };
          return { matches, skipped, next: next.file < input.paths.length ? next : null };
        }
      }
      if (page.nextStartLine !== null) {
        line = page.nextStartLine - 1;
        yield* Effect.yieldNow;
        continue;
      }
      break;
    }
    if (matches.length >= matchLimit) {
      const next = file + 1 < input.paths.length ? { file: file + 1, line: 0 } : null;
      return { matches, skipped, next };
    }
  }
  return { matches, skipped, next: null };
});
